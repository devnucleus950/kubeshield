// Contract 3 (section 6.3): what travels through Redis.
// Stream names live here so the API, the worker and the tests cannot disagree.
import type { FalcoEvent } from './falco.js';

export const RAW_STREAM = 'events:raw';
export const DEAD_STREAM = 'events:dead';
export const CONSUMER_GROUP = 'workers';

export interface StreamNames {
  raw: string;
  dead: string;
  group: string;
}

// Tests pass a prefix (for example "test:abc:") so they never touch dev data.
export function streamNames(prefix = ''): StreamNames {
  return { raw: `${prefix}${RAW_STREAM}`, dead: `${prefix}${DEAD_STREAM}`, group: CONSUMER_GROUP };
}

// Each stream entry has two fields: event_id and payload (a JSON string).
export interface StreamPayload {
  event: FalcoEvent;
  received_at: string; // ISO timestamp from the ingest clock
}

export function encodePayload(event: FalcoEvent, receivedAt: Date): string {
  const payload: StreamPayload = { event, received_at: receivedAt.toISOString() };
  return JSON.stringify(payload);
}

// Throws on anything that is not our payload shape; the worker treats that as a poison message.
export function decodePayload(json: string): StreamPayload {
  const value: unknown = JSON.parse(json);
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as StreamPayload).received_at !== 'string' ||
    typeof (value as StreamPayload).event !== 'object' ||
    (value as StreamPayload).event === null
  ) {
    throw new Error('payload is not { event, received_at }');
  }
  return value as StreamPayload;
}
