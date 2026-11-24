import { describe, expect, it } from 'vitest';
import { falcoEventSchema } from './falco.js';
import { sampleFalcoEvent } from './fixtures.js';
import { decodePayload, encodePayload, streamNames } from './streams.js';

describe('streams', () => {
  it('uses the spec names and supports a test prefix', () => {
    expect(streamNames()).toEqual({ raw: 'events:raw', dead: 'events:dead', group: 'workers' });
    expect(streamNames('t1:').raw).toBe('t1:events:raw');
  });

  it('round-trips a payload', () => {
    const event = falcoEventSchema.parse(sampleFalcoEvent());
    const back = decodePayload(encodePayload(event, new Date('2026-11-24T10:00:00Z')));
    expect(back.received_at).toBe('2026-11-24T10:00:00.000Z');
    expect(back.event.rule).toBe(event.rule);
  });

  it('throws on garbage so the worker can dead-letter it', () => {
    expect(() => decodePayload('not json')).toThrow();
    expect(() => decodePayload('{"nope":1}')).toThrow();
    expect(() => decodePayload('null')).toThrow();
  });
});
