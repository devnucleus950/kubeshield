// Integration tests: need Redis and Postgres running (docker compose up -d).
// They use a prefixed test stream and the kubeshield_test database.
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import pg from 'pg';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  encodePayload,
  falcoEventSchema,
  parseConfig,
  sampleFalcoEvent,
  streamNames,
  withDatabase,
  workerConfigSchema,
} from '@kubeshield/shared';
import { processBatch, type Ctx } from './batch.js';
import { Consumer } from './consumer.js';
import { ensureGroup } from './streamIo.js';

const prefix = `test:worker:${randomUUID()}:`;
const names = streamNames(prefix);
const baseEnv = {
  REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
  DATABASE_URL: withDatabase(process.env.DATABASE_URL ?? '', 'kubeshield_test'),
  STREAM_PREFIX: prefix,
  LOG_LEVEL: 'silent',
  WORKER_BLOCK_MS: '100',
};
const logger = pino({ level: 'silent' });

let redis: Redis; // used by the tests to look inside Redis
let pool: pg.Pool;
const toClose: { quit(): unknown }[] = [];
const consumers: Consumer[] = [];

function makeConsumer(env: Record<string, string> = {}, usePool: pg.Pool = pool, name?: string): Consumer {
  const config = parseConfig(workerConfigSchema, { ...baseEnv, ...env });
  const own = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  toClose.push(own);
  const c = new Consumer({ config, redis: own, pool: usePool, logger, consumerName: name, backoff: { minMs: 5, maxMs: 20 } });
  consumers.push(c);
  return c;
}

async function add(eventId = randomUUID(), overrides: Record<string, unknown> = {}): Promise<string> {
  const event = falcoEventSchema.parse(sampleFalcoEvent(overrides));
  await redis.xadd(names.raw, '*', 'event_id', eventId, 'payload', encodePayload(event, new Date()));
  return eventId;
}

const rowCount = async () => Number((await pool.query('SELECT count(*) AS n FROM events')).rows[0].n);
const pendingCount = async () => {
  try {
    const r = (await redis.xpending(names.raw, names.group)) as [number, ...unknown[]];
    return Number(r[0]);
  } catch (err) {
    if ((err as Error).message.includes('NOGROUP')) return 0; // group not created yet = nothing pending
    throw err;
  }
};
const deadEntries = async () => redis.xrange(names.dead, '-', '+');

async function waitFor(check: () => Promise<boolean>, what: string, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

beforeAll(() => {
  redis = new Redis(baseEnv.REDIS_URL);
  pool = new pg.Pool({ connectionString: baseEnv.DATABASE_URL, max: 4 });
});
beforeEach(async () => {
  await pool.query('TRUNCATE events');
  await redis.del(names.raw, names.dead);
});
afterEach(async () => {
  await Promise.all(consumers.splice(0).map((c) => c.stop()));
  await Promise.all(toClose.splice(0).map((c) => c.quit()));
});
afterAll(async () => {
  await redis.del(names.raw, names.dead);
  await pool.query('TRUNCATE events');
  await redis.quit();
  await pool.end();
});

describe('worker: normal flow', () => {
  it('stores events from the stream and acknowledges them', async () => {
    const ids = [await add(), await add(), await add()];
    makeConsumer().start();
    await waitFor(async () => (await rowCount()) === 3, 'three rows');
    await waitFor(async () => (await pendingCount()) === 0, 'pending drained');

    const { rows } = await pool.query('SELECT * FROM events WHERE event_id = $1', [ids[0]]);
    expect(rows[0]).toMatchObject({
      rule: 'Terminal shell in container',
      priority_rank: 5,
      pod: 'payments-7d9f-xk2lp',
      container_id: 'a1b2c3d4e5f6',
    });
    expect(rows[0].raw.rule).toBe('Terminal shell in container');
    expect((await deadEntries()).length).toBe(0);
  });

  it('picks up events that arrive after it started', async () => {
    makeConsumer().start();
    await new Promise((r) => setTimeout(r, 200));
    await add();
    await waitFor(async () => (await rowCount()) === 1, 'one row');
  });
});

describe('worker: duplicates', () => {
  it('stores one row when the same event_id is delivered twice', async () => {
    const id = randomUUID();
    await add(id);
    await add(id);
    makeConsumer().start();
    await waitFor(async () => (await pendingCount()) === 0 && (await rowCount()) === 1, 'one row, drained');
    expect(await rowCount()).toBe(1);
  });

  it('counts a replay after a crash-before-ack as a duplicate, not a new row', async () => {
    await add();
    const c = makeConsumer();
    await ensureGroup(redis, names);
    const raw = (await redis.call('XREADGROUP', 'GROUP', names.group, 'tester', 'COUNT', 10, 'STREAMS', names.raw, '>')) as [string, [string, string[]][]][];
    const entries = raw[0]![1].map(([id, flat]) => ({ id, fields: { event_id: flat[1]!, payload: flat[3]! } }));
    const ctx: Ctx = { redis, pool, names, maxDeliveries: 5, logger };

    const first = await processBatch(ctx, entries, false);
    expect(first).toMatchObject({ inserted: 1, duplicates: 0, dead: 0 });
    const replay = await processBatch(ctx, entries, false); // as if the ack never happened
    expect(replay).toMatchObject({ inserted: 0, duplicates: 1, dead: 0 });
    expect(await rowCount()).toBe(1);
    void c;
  });
});

describe('worker: poison messages', () => {
  it('moves unparseable messages to events:dead, acknowledges them and keeps running', async () => {
    await redis.xadd(names.raw, '*', 'event_id', randomUUID(), 'payload', 'this is not json');
    await redis.xadd(names.raw, '*', 'event_id', 'not-a-uuid', 'payload', encodePayload(falcoEventSchema.parse(sampleFalcoEvent()), new Date()));
    await redis.xadd(names.raw, '*', 'event_id', randomUUID(), 'payload', JSON.stringify({ event: { rule: 'no time' }, received_at: new Date().toISOString() }));
    await redis.xadd(names.raw, '*', 'only_junk', '1');
    await add();

    makeConsumer().start();
    await waitFor(async () => (await rowCount()) === 1, 'the good event stored');
    await waitFor(async () => (await pendingCount()) === 0, 'nothing pending');

    const dead = await deadEntries();
    expect(dead).toHaveLength(4);
    const reasons = dead.map(([, f]) => f[f.indexOf('reason') + 1]);
    expect(reasons.join('|')).toMatch(/unparseable payload/);
    expect(reasons.join('|')).toMatch(/invalid event_id/);
    expect(reasons.join('|')).toMatch(/failed validation/);
    expect(dead[0]![1]).toEqual(expect.arrayContaining(['event_id', 'payload', 'reason', 'failed_at']));

    await add(); // still alive after the poison
    await waitFor(async () => (await rowCount()) === 2, 'worker still running');
  });

  it('isolates a row Postgres rejects (NUL character) without losing its neighbours', async () => {
    await add();
    await add(randomUUID(), { output: 'bad\u0000byte' });
    await add();
    makeConsumer().start();
    await waitFor(async () => (await rowCount()) === 2, 'two good rows');
    await waitFor(async () => (await pendingCount()) === 0, 'nothing pending');
    const dead = await deadEntries();
    expect(dead).toHaveLength(1);
    expect(dead[0]![1].join(' ')).toMatch(/database rejected row/);
  });
});

describe('worker: crashes and takeover', () => {
  async function deliverWithoutAck(consumerName: string): Promise<void> {
    await ensureGroup(redis, names);
    await redis.call('XREADGROUP', 'GROUP', names.group, consumerName, 'COUNT', 100, 'STREAMS', names.raw, '>');
  }

  it('takes over messages left pending by a dead worker', async () => {
    for (let i = 0; i < 5; i++) await add();
    await deliverWithoutAck('worker-that-crashed');
    expect(await pendingCount()).toBe(5);
    expect(await rowCount()).toBe(0);

    makeConsumer({ WORKER_RECLAIM_IDLE_MS: '0' }).start(); // idle threshold 0 so the test is fast
    await waitFor(async () => (await rowCount()) === 5, 'five rows recovered');
    await waitFor(async () => (await pendingCount()) === 0, 'pending drained to 0');
  });

  it('does NOT take over messages that are not idle long enough', async () => {
    await add();
    await deliverWithoutAck('worker-still-busy');
    makeConsumer({ WORKER_RECLAIM_IDLE_MS: '60000' }).start();
    await new Promise((r) => setTimeout(r, 500));
    expect(await rowCount()).toBe(0);
    expect(await pendingCount()).toBe(1);
  });

  it('re-reads its own pending messages first when restarted with the same name', async () => {
    await add();
    await add();
    await deliverWithoutAck('worker-fixed-name');
    makeConsumer({ WORKER_RECLAIM_IDLE_MS: '600000' }, pool, 'worker-fixed-name').start();
    await waitFor(async () => (await rowCount()) === 2, 'own pending processed');
    await waitFor(async () => (await pendingCount()) === 0, 'pending drained');
  });

  it('dead-letters a message delivered more than the limit instead of retrying forever', async () => {
    const id = await add();
    await deliverWithoutAck('crash-loop');
    const entryId = (await redis.xrange(names.raw, '-', '+'))[0]![0];
    for (let i = 0; i < 6; i++) await redis.call('XCLAIM', names.raw, names.group, 'crash-loop', 0, entryId);

    makeConsumer({ WORKER_RECLAIM_IDLE_MS: '0', WORKER_MAX_DELIVERIES: '5' }).start();
    await waitFor(async () => (await deadEntries()).length === 1, 'dead-lettered');
    await waitFor(async () => (await pendingCount()) === 0, 'acknowledged');
    expect(await rowCount()).toBe(0);
    const fields = (await deadEntries())[0]![1];
    expect(fields[fields.indexOf('reason') + 1]).toMatch(/delivered more than 5 times/);
    expect(fields[fields.indexOf('event_id') + 1]).toBe(id);
  });
});

describe('worker: Postgres outage', () => {
  it('retries with backoff and stores everything, even when the outage outlasts the delivery limit', async () => {
    for (let i = 0; i < 4; i++) await add();

    // A pool that refuses connections 8 times (more than WORKER_MAX_DELIVERIES = 5), then recovers.
    let failures = 8;
    const flaky = {
      connect: async () => {
        if (failures-- > 0) throw new Error('connect ECONNREFUSED 127.0.0.1:5433');
        return pool.connect();
      },
    } as unknown as pg.Pool;

    makeConsumer({}, flaky).start();
    await waitFor(async () => (await rowCount()) === 4, 'all four stored after recovery');
    await waitFor(async () => (await pendingCount()) === 0, 'pending drained');
    expect(failures).toBeLessThan(0); // it really did fail and retry
    expect((await deadEntries()).length).toBe(0); // an outage never dead-letters good events
  });
});

describe('worker: shutdown', () => {
  it('stop() finishes the loop and leaves nothing pending', async () => {
    for (let i = 0; i < 20; i++) await add();
    const c = makeConsumer();
    c.start();
    await waitFor(async () => (await rowCount()) > 0, 'started processing');
    await c.stop();
    expect(await pendingCount()).toBe(0);
  });
});
