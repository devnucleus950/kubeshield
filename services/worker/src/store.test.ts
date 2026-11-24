import { EventEmitter } from 'node:events';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { falcoEventSchema, normalize, sampleFalcoEvent } from '@kubeshield/shared';
import { buildInsert, isDataError, storeEvents } from './store.js';

const event = (id: string) =>
  normalize(falcoEventSchema.parse(sampleFalcoEvent()), id, '2026-11-24T10:00:00.000Z');

describe('buildInsert', () => {
  it('builds one multi-row insert with the right number of placeholders', () => {
    const { text, values } = buildInsert([event('a'), event('b')]);
    expect(values).toHaveLength(46); // 23 columns x 2 rows
    expect(text).toContain('$1,');
    expect(text).toContain('$46::jsonb');
    expect(text).toContain('ON CONFLICT (event_id) DO NOTHING');
    expect(text.match(/\(\$/g)).toHaveLength(2); // two row groups
  });

  it('sends raw as a JSON string for the jsonb cast', () => {
    const { values } = buildInsert([event('a')]);
    expect(typeof values[22]).toBe('string');
    expect(JSON.parse(values[22] as string).rule).toBe('Terminal shell in container');
  });
});

describe('isDataError', () => {
  it('treats SQLSTATE class 22/23 as bad data and everything else as infrastructure', () => {
    expect(isDataError({ code: '22021' })).toBe(true);
    expect(isDataError({ code: '23502' })).toBe(true);
    expect(isDataError({ code: '57P01' })).toBe(false);
    expect(isDataError({ code: 'ECONNREFUSED' })).toBe(false);
    expect(isDataError(new Error('boom'))).toBe(false);
  });
});

describe('storeEvents when Postgres vanishes mid-query', () => {
  // Regression: this used to crash the worker with an uncaught 'error' event
  // on the checked-out connection (found by the Postgres-outage drill).
  it('rejects with the failure instead of crashing the process', async () => {
    class DyingClient extends EventEmitter {
      released: unknown = 'not released';
      async query(sql: string): Promise<unknown> {
        if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
        queueMicrotask(() => this.emit('error', new Error('terminating connection due to administrator command')));
        throw Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' });
      }
      release(err?: Error): void {
        this.released = err ?? 'clean';
      }
    }
    const client = new DyingClient();
    const pool = { connect: async () => client } as unknown as pg.Pool;
    await expect(storeEvents(pool, [event('a')])).rejects.toThrow(/terminating connection/);
    await new Promise((r) => setTimeout(r, 10)); // let the emitted 'error' fire
    expect(client.released).toBeInstanceOf(Error); // connection discarded, not reused
    expect(client.listenerCount('error')).toBe(0); // we cleaned up our listener
  });
});
