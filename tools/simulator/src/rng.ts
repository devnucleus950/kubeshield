// A small seeded random number generator (mulberry32). The same seed always
// gives the same sequence, which is what makes `--seed` reproducible.
import { randomInt } from 'node:crypto';

export interface Rng {
  next(): number; // 0 <= n < 1
  int(min: number, max: number): number; // inclusive
  pick<T>(items: readonly T[]): T;
  hex(length: number): string;
  alnum(length: number): string;
  fork(): Rng; // an independent generator derived from this one
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));
  const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)]!;
  const chars = (alphabet: string, length: number): string =>
    Array.from({ length }, () => alphabet[int(0, alphabet.length - 1)]).join('');
  return {
    next,
    int,
    pick,
    hex: (length) => chars('0123456789abcdef', length),
    alnum: (length) => chars('bcdfghjklmnpqrstvwxz2456789', length), // Kubernetes-style, no vowels
    fork: () => createRng(Math.floor(next() * 4294967296)),
  };
}

// "--seed 42" and "--seed demo" both work. No seed means a random one.
export function seedFrom(value: string | undefined): number {
  if (value === undefined) return randomInt(0, 2 ** 31);
  if (/^\d+$/.test(value)) return Number(value) >>> 0;
  let hash = 2166136261; // FNV-1a hash of the text
  for (const ch of value) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619) >>> 0;
  return hash;
}
