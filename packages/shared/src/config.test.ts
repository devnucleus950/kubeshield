import { describe, expect, it } from 'vitest';
import { ConfigError, ingestConfigSchema, parseConfig, withDatabase, workerConfigSchema } from './config.js';

const good = {
  INGEST_API_KEY: 'a'.repeat(32),
  REDIS_URL: 'redis://127.0.0.1:6379',
  DATABASE_URL: 'postgres://u:p@127.0.0.1:5433/kubeshield',
};

describe('parseConfig', () => {
  it('applies defaults and coerces numbers', () => {
    const c = parseConfig(ingestConfigSchema, { ...good, INGEST_PORT: '4100' });
    expect(c.INGEST_PORT).toBe(4100);
    expect(c.STREAM_MAXLEN).toBe(100_000);
    expect(c.LOG_LEVEL).toBe('info');
  });

  it('fails fast with a readable message naming the variable', () => {
    const { REDIS_URL: _omit, ...missing } = good;
    expect(() => parseConfig(ingestConfigSchema, missing)).toThrow(ConfigError);
    expect(() => parseConfig(ingestConfigSchema, missing)).toThrow(/REDIS_URL.*\(not set\)/);
  });

  it('rejects a weak API key and a bad port', () => {
    expect(() => parseConfig(ingestConfigSchema, { ...good, INGEST_API_KEY: 'short' })).toThrow(/INGEST_API_KEY/);
    expect(() => parseConfig(ingestConfigSchema, { ...good, INGEST_PORT: 'abc' })).toThrow(/INGEST_PORT/);
  });

  it('worker config does not need the API key', () => {
    const c = parseConfig(workerConfigSchema, { REDIS_URL: good.REDIS_URL, DATABASE_URL: good.DATABASE_URL });
    expect(c.WORKER_BATCH_SIZE).toBe(50);
    expect(c.WORKER_MAX_DELIVERIES).toBe(5);
  });
});

describe('withDatabase', () => {
  it('swaps only the database name', () => {
    expect(withDatabase(good.DATABASE_URL, 'kubeshield_test')).toBe('postgres://u:p@127.0.0.1:5433/kubeshield_test');
  });
});
