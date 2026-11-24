import { describe, expect, it } from 'vitest';
import { falcoEventSchema, normalize, sampleFalcoEvent } from '@kubeshield/shared';
import { buildInsert, isDataError } from './store.js';

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
