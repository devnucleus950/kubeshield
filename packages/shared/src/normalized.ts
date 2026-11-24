// Contract 2 (section 6.2): the flat, typed event we store and use.
// normalize() turns Falco's dotted field names into real columns.
import { PRIORITIES, type FalcoEvent } from './falco.js';

export interface NormalizedEvent {
  event_id: string;
  occurred_at: string; // ISO timestamp
  received_at: string; // ISO timestamp
  rule: string;
  priority: string;
  priority_rank: number;
  output: string;
  tags: string[];
  hostname: string | null;
  namespace: string | null;
  pod: string | null;
  container_id: string | null;
  container_name: string | null;
  image: string | null;
  proc_name: string | null;
  proc_cmdline: string | null;
  proc_pid: number | null;
  proc_ppid: number | null;
  user_name: string | null;
  file_path: string | null;
  remote_ip: string | null;
  remote_port: number | null;
  raw: FalcoEvent; // never lose the original
}

type Fields = Record<string, unknown>;

// A missing or wrongly-typed optional field becomes null, never an error.
function str(fields: Fields, key: string): string | null {
  const v = fields[key];
  return typeof v === 'string' && v !== '' ? v : null;
}

function int(fields: Fields, key: string): number | null {
  const v = fields[key];
  if (typeof v === 'number' && Number.isSafeInteger(v)) return v;
  if (typeof v === 'string' && /^-?\d{1,15}$/.test(v)) return Number(v);
  return null;
}

// fd.name is a file path for file events but "ip:port->ip:port" for network
// events, so only a value starting with "/" counts as a path.
function filePath(fields: Fields): string | null {
  const name = str(fields, 'fd.name');
  return name !== null && name.startsWith('/') ? name : null;
}

export function priorityRank(priority: string): number {
  return PRIORITIES.indexOf(priority as (typeof PRIORITIES)[number]);
}

export function normalize(event: FalcoEvent, eventId: string, receivedAt: string): NormalizedEvent {
  const occurred = new Date(event.time);
  if (Number.isNaN(occurred.getTime())) throw new Error(`invalid time: ${event.time}`);
  const rank = priorityRank(event.priority);
  if (rank < 0) throw new Error(`unknown priority: ${event.priority}`);

  const f = event.output_fields;
  return {
    event_id: eventId,
    occurred_at: occurred.toISOString(),
    received_at: receivedAt,
    rule: event.rule,
    priority: event.priority,
    priority_rank: rank,
    output: event.output,
    tags: event.tags,
    hostname: event.hostname ?? null,
    namespace: str(f, 'k8s.ns.name'),
    pod: str(f, 'k8s.pod.name'),
    container_id: str(f, 'container.id'),
    container_name: str(f, 'container.name'),
    image: str(f, 'container.image.repository'),
    proc_name: str(f, 'proc.name'),
    proc_cmdline: str(f, 'proc.cmdline'),
    proc_pid: int(f, 'proc.pid'),
    proc_ppid: int(f, 'proc.ppid'),
    user_name: str(f, 'user.name'),
    file_path: filePath(f),
    remote_ip: str(f, 'fd.sip') ?? str(f, 'fd.rip'),
    remote_port: int(f, 'fd.sport') ?? int(f, 'fd.rport'),
    raw: event,
  };
}
