// Thin wrappers over raw Redis stream commands. ioredis types for these
// commands are awkward, so we send them with call() and parse the replies here.
import type { Redis } from 'ioredis';
import type { StreamNames } from '@kubeshield/shared';
import type { Entry } from './batch.js';

type RawEntry = [string, string[] | null];

function toEntries(raw: RawEntry[] | null | undefined): Entry[] {
  return (raw ?? []).map(([id, flat]) => {
    if (!flat) return { id, fields: null };
    const fields: Record<string, string> = {};
    for (let i = 0; i + 1 < flat.length; i += 2) fields[flat[i]!] = flat[i + 1]!;
    return { id, fields };
  });
}

export async function ensureGroup(redis: Redis, names: StreamNames): Promise<void> {
  try {
    // Start at 0 so events added before the group existed are still processed.
    await redis.call('XGROUP', 'CREATE', names.raw, names.group, '0', 'MKSTREAM');
  } catch (err) {
    if (!(err as Error).message.includes('BUSYGROUP')) throw err; // BUSYGROUP = already exists, fine
  }
}

// Read NEW messages (">"), waiting up to blockMs when the stream is empty.
export async function readNew(
  redis: Redis, names: StreamNames, consumer: string, count: number, blockMs: number,
): Promise<Entry[]> {
  const reply = (await redis.call(
    'XREADGROUP', 'GROUP', names.group, consumer,
    'COUNT', count, 'BLOCK', blockMs, 'STREAMS', names.raw, '>',
  )) as [string, RawEntry[]][] | null;
  return toEntries(reply?.[0]?.[1]);
}

// Read this consumer's OWN pending messages: delivered earlier, never acknowledged.
export async function readOwnPending(
  redis: Redis, names: StreamNames, consumer: string, count: number,
): Promise<Entry[]> {
  const reply = (await redis.call(
    'XREADGROUP', 'GROUP', names.group, consumer, 'COUNT', count, 'STREAMS', names.raw, '0',
  )) as [string, RawEntry[]][] | null;
  return toEntries(reply?.[0]?.[1]);
}

// Take over messages that have sat unacknowledged for at least minIdleMs.
// Works on any consumer's messages, so it recovers work from dead workers.
export async function autoClaim(
  redis: Redis, names: StreamNames, consumer: string, minIdleMs: number, start: string, count: number,
): Promise<{ next: string; entries: Entry[] }> {
  const reply = (await redis.call(
    'XAUTOCLAIM', names.raw, names.group, consumer, minIdleMs, start, 'COUNT', count,
  )) as [string, RawEntry[]];
  return { next: reply[0], entries: toEntries(reply[1]) };
}
