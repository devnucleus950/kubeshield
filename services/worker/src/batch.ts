// Processes one batch of stream entries: parse, normalize, store, then acknowledge.
// The order is the whole point: write to Postgres FIRST, acknowledge SECOND.
// A crash in between just means redelivery, which the primary key makes harmless.
import type { Redis } from 'ioredis';
import type pg from 'pg';
import type { Logger } from 'pino';
import { z } from 'zod';
import {
  decodePayload,
  falcoEventSchema,
  normalize,
  type NormalizedEvent,
  type StreamNames,
} from '@kubeshield/shared';
import { storeEvents } from './store.js';

export interface Entry {
  id: string; // stream entry id, e.g. 1700000000000-0
  fields: Record<string, string> | null; // null when the entry was trimmed away
}

export interface Ctx {
  redis: Redis;
  pool: pg.Pool;
  names: StreamNames;
  maxDeliveries: number;
  logger: Logger;
}

export interface BatchStats {
  read: number;
  inserted: number;
  duplicates: number;
  dead: number;
  ms: number;
}

const uuid = z.uuid();

interface DeadItem {
  entry: Entry;
  reason: string;
}

// Turns a raw stream entry into a NormalizedEvent, or says why it cannot.
function parseEntry(entry: Entry): NormalizedEvent | { reason: string } {
  if (!entry.fields) return { reason: 'entry was trimmed from the stream before it could be read' };
  try {
    const id = uuid.safeParse(entry.fields.event_id);
    if (!id.success) return { reason: 'invalid event_id' };
    const payload = decodePayload(entry.fields.payload ?? '');
    const received = new Date(payload.received_at);
    if (Number.isNaN(received.getTime())) return { reason: 'invalid received_at' };
    const event = falcoEventSchema.safeParse(payload.event);
    if (!event.success) return { reason: 'event failed validation' };
    return normalize(event.data, id.data, received.toISOString());
  } catch (err) {
    return { reason: `unparseable payload: ${(err as Error).message}` };
  }
}

// How many times Redis has delivered each message (the 4th field of XPENDING).
async function deliveryCounts(ctx: Ctx, ids: string[]): Promise<Map<string, number>> {
  const pipeline = ctx.redis.pipeline();
  for (const id of ids) pipeline.call('XPENDING', ctx.names.raw, ctx.names.group, id, id, '1');
  const results = await pipeline.exec();
  const counts = new Map<string, number>();
  results?.forEach(([err, reply], i) => {
    if (err) throw err;
    const row = (reply as [string, string, number, number][])[0];
    if (row) counts.set(ids[i]!, Number(row[3]));
  });
  return counts;
}

async function deadLetter(ctx: Ctx, items: DeadItem[]): Promise<void> {
  if (items.length === 0) return;
  const failedAt = new Date().toISOString();
  const pipeline = ctx.redis.pipeline();
  for (const { entry, reason } of items) {
    pipeline.xadd(
      ctx.names.dead, '*',
      'event_id', entry.fields?.event_id ?? '',
      'payload', entry.fields?.payload ?? '',
      'reason', reason,
      'failed_at', failedAt,
    );
  }
  const results = await pipeline.exec();
  if (!results || results.some(([err]) => err)) throw new Error('could not write to the dead-letter stream');
  // Reasons only: payloads may contain sensitive data from the monitored cluster.
  ctx.logger.warn({ count: items.length, reasons: [...new Set(items.map((i) => i.reason))] }, 'dead-lettered');
}

// `redelivered` is true for entries that were delivered before (crash recovery
// or takeover). Only those can have hit the delivery limit.
export async function processBatch(ctx: Ctx, entries: Entry[], redelivered: boolean): Promise<BatchStats> {
  const started = performance.now();
  const dead: DeadItem[] = [];
  const good: NormalizedEvent[] = [];

  let counts = new Map<string, number>();
  if (redelivered && entries.length > 0) counts = await deliveryCounts(ctx, entries.map((e) => e.id));

  for (const entry of entries) {
    if ((counts.get(entry.id) ?? 0) > ctx.maxDeliveries) {
      dead.push({ entry, reason: `delivered more than ${ctx.maxDeliveries} times` });
      continue;
    }
    const parsed = parseEntry(entry);
    if ('reason' in parsed) dead.push({ entry, reason: parsed.reason });
    else good.push(parsed);
  }

  // 1. Postgres first. A real outage throws here, so nothing below runs and nothing is acknowledged.
  const stored = await storeEvents(ctx.pool, good);
  const byEventId = new Map(entries.map((e) => [e.fields?.event_id, e]));
  for (const { event, reason } of stored.rejected) {
    dead.push({ entry: byEventId.get(event.event_id)!, reason });
  }

  // 2. Dead-letter the bad ones, 3. only then acknowledge everything we handled.
  await deadLetter(ctx, dead);
  if (entries.length > 0) {
    await ctx.redis.xack(ctx.names.raw, ctx.names.group, ...entries.map((e) => e.id));
  }

  return {
    read: entries.length,
    inserted: stored.inserted,
    duplicates: stored.duplicates,
    dead: dead.length,
    ms: Math.round(performance.now() - started),
  };
}
