// The business logic of ingest, kept out of the route files:
// validate a request body, then publish the events to the Redis stream.
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { encodePayload, falcoEventSchema, type FalcoEvent } from '@kubeshield/shared';
import { HttpError, type Issue } from './errors.js';

export const MAX_BATCH = 100;

// Accepts one event or an array of up to 100. If ANY event is invalid the whole
// request is rejected (no partial acceptance), and every problem is listed with
// its array position.
export function validateBody(body: unknown): FalcoEvent[] {
  if (body === undefined || body === null || typeof body !== 'object') {
    throw new HttpError(400, 'invalid_body', 'Body must be a JSON object or an array of objects (Content-Type: application/json)');
  }
  const isBatch = Array.isArray(body);
  const items: unknown[] = isBatch ? body : [body];

  if (items.length === 0) throw new HttpError(400, 'invalid_body', 'Array must contain at least one event');
  if (items.length > MAX_BATCH) {
    throw new HttpError(400, 'batch_too_large', `At most ${MAX_BATCH} events per request`);
  }

  const events: FalcoEvent[] = [];
  const issues: Issue[] = [];
  items.forEach((item, index) => {
    const result = falcoEventSchema.safeParse(item);
    if (result.success) {
      events.push(result.data);
      return;
    }
    for (const issue of result.error.issues) {
      // Messages describe the rule that failed; they never echo the submitted value.
      issues.push({ ...(isBatch ? { index } : {}), path: issue.path.join('.') || '(event)', message: issue.message });
    }
  });

  if (issues.length > 0) throw new HttpError(400, 'validation_failed', 'One or more events are invalid', issues);
  return events;
}

export interface Published {
  eventIds: string[];
  receivedAt: Date;
}

// Writes all events to the stream in ONE pipeline. Returns only after Redis
// has accepted every one, so the caller may safely reply 202.
export async function publishEvents(
  redis: Redis,
  stream: string,
  maxlen: number,
  events: FalcoEvent[],
): Promise<Published> {
  const receivedAt = new Date();
  const eventIds = events.map(() => randomUUID());

  try {
    const pipeline = redis.pipeline();
    events.forEach((event, i) => {
      // MAXLEN ~ : trim the stream to roughly this size (approximate is much cheaper).
      pipeline.xadd(stream, 'MAXLEN', '~', maxlen, '*', 'event_id', eventIds[i]!, 'payload', encodePayload(event, receivedAt));
    });
    const results = await pipeline.exec();
    const failed = !results || results.some(([err]) => err !== null);
    if (failed) throw new Error('one or more XADD commands failed');
  } catch {
    // Never say 202 unless Redis holds the event.
    throw new HttpError(503, 'queue_unavailable', 'Event queue is unavailable, retry shortly', undefined, {
      'Retry-After': '5',
    });
  }
  return { eventIds, receivedAt };
}
