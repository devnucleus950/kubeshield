import { describe, expect, it } from 'vitest';
import { falcoEventSchema } from './falco.js';
import { sampleFalcoEvent } from './fixtures.js';

const ok = (e: unknown) => falcoEventSchema.safeParse(e).success;

describe('falcoEventSchema', () => {
  it('accepts a valid event', () => {
    expect(ok(sampleFalcoEvent())).toBe(true);
  });

  it('fills defaults for optional fields', () => {
    const r = falcoEventSchema.parse({ time: '2026-11-24T10:00:00Z', rule: 'r', priority: 'Debug', output: 'o' });
    expect(r.tags).toEqual([]);
    expect(r.output_fields).toEqual({});
  });

  it('keeps unknown extra fields', () => {
    const r = falcoEventSchema.parse(sampleFalcoEvent({ source: 'syscall', future_field: 1 }));
    expect(r).toMatchObject({ source: 'syscall', future_field: 1 });
  });

  it.each([
    ['missing rule', { rule: undefined }],
    ['empty rule', { rule: '' }],
    ['bad time', { time: 'yesterday' }],
    ['time not a string', { time: 12345 }],
    ['unknown priority', { priority: 'Catastrophic' }],
    ['lowercase priority', { priority: 'notice' }],
    ['tags wrong type', { tags: 'shell' }],
    ['output_fields wrong type', { output_fields: [1, 2] }],
    ['oversized rule', { rule: 'x'.repeat(600) }],
  ])('rejects %s', (_name, override) => {
    expect(ok(sampleFalcoEvent(override))).toBe(false);
  });

  it('rejects non-objects', () => {
    for (const bad of [null, 'text', 42, [], undefined]) expect(ok(bad)).toBe(false);
  });
});
