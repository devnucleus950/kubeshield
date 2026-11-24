import { describe, expect, it } from 'vitest';
import { safeEqual } from './apiKey.js';

describe('safeEqual', () => {
  it('matches equal strings and rejects different ones, whatever the length', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', 'abc')).toBe(false);
  });
});
