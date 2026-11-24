// Integration tests: need Redis and Postgres running (docker compose up -d).
// They use a prefixed test stream and the kubeshield_test database.
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import pg from 'pg';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  decodePayload,
  ingestConfigSchema,
  parseConfig,
  sampleFalcoEvent,
  streamNames,
  withDatabase,
  type IngestConfig,
} from '@kubeshield/shared';
import { createApp } from './app.js';

const KEY = 'test-key-0123456789abcdef0123456789abcdef';
const prefix = `test:ingest:${randomUUID()}:`;
const stream = streamNames(prefix).raw;

const config: IngestConfig = parseConfig(ingestConfigSchema, {
  INGEST_API_KEY: KEY,
  REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
  DATABASE_URL: withDatabase(process.env.DATABASE_URL ?? '', 'kubeshield_test'),
  STREAM_PREFIX: prefix,
  LOG_LEVEL: 'silent',
});
const logger = pino({ level: 'silent' });

let redis: Redis;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>;

const post = (body: unknown, key: string | null = KEY) => {
  const r = request(app).post('/v1/events');
  if (key) r.set('x-api-key', key);
  return r.set('content-type', 'application/json').send(typeof body === 'string' ? body : JSON.stringify(body));
};

beforeAll(async () => {
  redis = new Redis(config.REDIS_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
  await new Promise((resolve) => redis.once('ready', resolve));
  pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 2 });
  app = createApp({ config, redis, pool, logger });
});
beforeEach(async () => {
  await redis.del(stream);
});
afterAll(async () => {
  await redis.del(stream);
  await redis.quit();
  await pool.end();
});

describe('POST /v1/events', () => {
  it('accepts one event with 202 and puts it in the stream', async () => {
    const res = await post(sampleFalcoEvent());
    expect(res.status).toBe(202);
    expect(res.body.accepted).toBe(1);
    expect(res.body.event_ids).toHaveLength(1);
    expect(await redis.xlen(stream)).toBe(1);

    const [entry] = await redis.xrange(stream, '-', '+');
    const fields = entry![1];
    expect(fields[0]).toBe('event_id');
    expect(fields[1]).toBe(res.body.event_ids[0]);
    expect(decodePayload(fields[3]!).event.rule).toBe('Terminal shell in container');
  });

  it('accepts an array of events in one request', async () => {
    const res = await post([sampleFalcoEvent(), sampleFalcoEvent({ rule: 'Other' }), sampleFalcoEvent()]);
    expect(res.status).toBe(202);
    expect(res.body.accepted).toBe(3);
    expect(new Set(res.body.event_ids).size).toBe(3);
    expect(await redis.xlen(stream)).toBe(3);
  });

  it('returns 401 for a missing or wrong key, with the same body', async () => {
    const missing = await post(sampleFalcoEvent(), null);
    const wrong = await post(sampleFalcoEvent(), 'nope');
    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(missing.body).toEqual(wrong.body);
    expect(await redis.xlen(stream)).toBe(0);
  });

  it('returns 400 with array positions and stores nothing if any event is invalid', async () => {
    const res = await post([sampleFalcoEvent(), sampleFalcoEvent({ rule: undefined }), sampleFalcoEvent({ priority: 'Nope' })]);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
    const indexes = res.body.error.issues.map((i: { index: number }) => i.index);
    expect(indexes).toEqual(expect.arrayContaining([1, 2]));
    expect(indexes).not.toContain(0);
    expect(await redis.xlen(stream)).toBe(0); // no partial acceptance
  });

  it('does not echo submitted values back in error messages', async () => {
    const res = await post(sampleFalcoEvent({ priority: 'SECRET-VALUE-123' }));
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('SECRET-VALUE-123');
  });

  it.each([
    ['invalid JSON', '{oops'],
    ['an empty body', ''],
    ['a JSON string', '"hello"'],
    ['a JSON number', '42'],
    ['null', 'null'],
    ['an empty array', '[]'],
    ['an empty object', '{}'],
  ])('returns 400 for %s', async (_name, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBeTruthy();
    expect(await redis.xlen(stream)).toBe(0);
  });

  it('returns 400 for more than 100 events', async () => {
    const res = await post(Array.from({ length: 101 }, () => sampleFalcoEvent()));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('batch_too_large');
  });

  it('returns 413 for a body over 1 MB', async () => {
    const res = await post(sampleFalcoEvent({ padding: 'x'.repeat(1.2 * 1024 * 1024) }));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('payload_too_large');
  });

  it('returns 503 with Retry-After, never 202, when Redis is down', async () => {
    const dead = new Redis(config.REDIS_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
    await new Promise((r) => dead.once('ready', r));
    dead.disconnect(); // simulates Redis going away
    const brokenApp = createApp({ config, redis: dead, pool, logger });
    const res = await request(brokenApp)
      .post('/v1/events')
      .set('x-api-key', KEY)
      .set('content-type', 'application/json')
      .send(JSON.stringify(sampleFalcoEvent()));
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBeTruthy();
    expect(res.body.error.code).toBe('queue_unavailable');
  });
});

describe('cross-cutting rules', () => {
  it('generates an x-request-id, and reuses a safe client-supplied one', async () => {
    const generated = await request(app).get('/healthz');
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const reused = await request(app).get('/healthz').set('x-request-id', 'my-trace-42');
    expect(reused.headers['x-request-id']).toBe('my-trace-42');
    const unsafe = await request(app).get('/healthz').set('x-request-id', 'bad id with spaces');
    expect(unsafe.headers['x-request-id']).not.toBe('bad id with spaces');
  });

  it('uses one error shape for unknown routes and sets security headers', async () => {
    const res = await request(app).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'not_found', message: 'Not found' } });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('health', () => {
  it('GET /healthz is always ok', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
  });
  it('GET /readyz is ready when Redis and Postgres answer', async () => {
    const res = await request(app).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready', redis: 'ok', postgres: 'ok' });
  });
});

describe('GET /v1/events (dev only)', () => {
  it('requires the API key', async () => {
    expect((await request(app).get('/v1/events')).status).toBe(401);
  });
  it('validates limit', async () => {
    const res = await request(app).get('/v1/events?limit=abc').set('x-api-key', KEY);
    expect(res.status).toBe(400);
  });
  it('returns stored events', async () => {
    const res = await request(app).get('/v1/events?limit=5').set('x-api-key', KEY);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.events)).toBe(true);
  });
});
