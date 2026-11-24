// Writes normalized events to Postgres in batches.
import type pg from 'pg';
import type { NormalizedEvent } from '@kubeshield/shared';

// Column order here must match the values order in rowValues() below.
const COLUMNS = [
  'event_id', 'occurred_at', 'received_at', 'rule', 'priority', 'priority_rank', 'output', 'tags',
  'hostname', 'namespace', 'pod', 'container_id', 'container_name', 'image', 'proc_name',
  'proc_cmdline', 'proc_pid', 'proc_ppid', 'user_name', 'file_path', 'remote_ip', 'remote_port', 'raw',
] as const;

function rowValues(e: NormalizedEvent): unknown[] {
  return [
    e.event_id, e.occurred_at, e.received_at, e.rule, e.priority, e.priority_rank, e.output, e.tags,
    e.hostname, e.namespace, e.pod, e.container_id, e.container_name, e.image, e.proc_name,
    e.proc_cmdline, e.proc_pid, e.proc_ppid, e.user_name, e.file_path, e.remote_ip, e.remote_port,
    JSON.stringify(e.raw), // sent as text, cast to jsonb in the SQL
  ];
}

// One multi-row INSERT. ON CONFLICT DO NOTHING is what makes redelivery harmless:
// the second insert of the same event_id changes nothing.
export function buildInsert(events: NormalizedEvent[]): { text: string; values: unknown[] } {
  const width = COLUMNS.length;
  const values: unknown[] = [];
  const rows = events.map((event, r) => {
    values.push(...rowValues(event));
    const marks = COLUMNS.map((col, c) => `$${r * width + c + 1}${col === 'raw' ? '::jsonb' : ''}`);
    return `(${marks.join(', ')})`;
  });
  const text = `INSERT INTO events (${COLUMNS.join(', ')}) VALUES ${rows.join(', ')} ON CONFLICT (event_id) DO NOTHING`;
  return { text, values };
}

// A "data error" is the database saying THIS row is bad (SQLSTATE class 22/23,
// for example a NUL character in text). Retrying will never help, unlike a
// connection error, which says nothing about the row.
export function isDataError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && (code.startsWith('22') || code.startsWith('23'));
}

async function insertTransaction(pool: pg.Pool, events: NormalizedEvent[]): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { text, values } = buildInsert(events);
    const result = await client.query(text, values);
    await client.query('COMMIT');
    client.release();
    return result.rowCount ?? 0;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release(err as Error); // a failed connection is discarded, not reused
    throw err;
  }
}

export interface StoreResult {
  inserted: number;
  duplicates: number;
  rejected: { event: NormalizedEvent; reason: string }[];
}

// Infrastructure errors (Postgres down, timeouts) are thrown to the caller,
// which backs off and retries. Only genuine bad-row errors are isolated.
export async function storeEvents(pool: pg.Pool, events: NormalizedEvent[]): Promise<StoreResult> {
  if (events.length === 0) return { inserted: 0, duplicates: 0, rejected: [] };
  try {
    const inserted = await insertTransaction(pool, events);
    return { inserted, duplicates: events.length - inserted, rejected: [] };
  } catch (err) {
    if (!isDataError(err)) throw err;
    // One bad row spoiled the batch. Find it by inserting one at a time.
    const result: StoreResult = { inserted: 0, duplicates: 0, rejected: [] };
    for (const event of events) {
      try {
        const n = await insertTransaction(pool, [event]);
        result.inserted += n;
        result.duplicates += 1 - n;
      } catch (rowErr) {
        if (!isDataError(rowErr)) throw rowErr;
        result.rejected.push({ event, reason: `database rejected row: ${(rowErr as Error).message}` });
      }
    }
    return result;
  }
}
