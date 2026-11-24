// Builds realistic Falco-style events. Scenarios describe WHAT happens; this
// file knows how Falco formats it.
import { FIELDS, type RuleDef } from './rules.js';
import type { Rng } from './rng.js';
import type { ScenarioContext, SimItem } from './scenario.js';

const APPS = ['payments', 'checkout', 'inventory', 'auth', 'search', 'orders'] as const;
const IMAGES: Record<(typeof APPS)[number], string> = {
  payments: 'acme/payments',
  checkout: 'acme/checkout',
  inventory: 'acme/inventory',
  auth: 'acme/auth',
  search: 'acme/search',
  orders: 'acme/orders',
};
const NODES = ['kubeshield-worker', 'kubeshield-worker2'] as const;

// Documentation-only address ranges (RFC 5737): they look like public IPs but
// can never belong to a real host, so the simulator cannot touch anyone.
const PUBLIC_RANGES = ['203.0.113', '198.51.100', '192.0.2'] as const;

export interface Container {
  pod: string;
  containerId: string;
  containerName: string;
  image: string;
  hostname: string;
  podIp: string;
}

// A fresh pod, like "payments-7d9f-xk2lp". Each scenario run gets its own.
export function makeContainer(rng: Rng): Container {
  const app = rng.pick(APPS);
  return {
    pod: `${app}-${rng.alnum(4)}-${rng.alnum(5)}`,
    containerId: rng.hex(12),
    containerName: app,
    image: IMAGES[app],
    hostname: rng.pick(NODES),
    podIp: `10.244.${rng.int(0, 3)}.${rng.int(2, 250)}`,
  };
}

export function publicIp(rng: Rng): string {
  return `${rng.pick(PUBLIC_RANGES)}.${rng.int(2, 250)}`;
}

export interface Proc {
  name: string;
  cmdline: string;
  pid: number;
  ppid: number;
  pname: string;
  user?: string;
}

export interface EventSpec {
  rule: RuleDef;
  container: Container;
  proc: Proc;
  offsetMs: number;
  extraFields?: Record<string, unknown>;
  tags?: string[]; // replaces the rule's default tags when given
}

// Falco stamps events with nanoseconds ("...07.123456789Z"); mimic that.
function falcoTimestamp(start: Date, offsetMs: number, rng: Rng): string {
  const iso = new Date(start.getTime() + offsetMs).toISOString(); // ends in ".123Z"
  return iso.slice(0, -1) + String(rng.int(0, 999_999)).padStart(6, '0') + 'Z';
}

export function falcoEvent(ctx: ScenarioContext, spec: EventSpec): Record<string, unknown> {
  const { rule, container: c, proc, extraFields } = spec;
  const user = proc.user ?? 'root';
  const output =
    `${rule.message} (user=${user} process=${proc.name} cmdline=${proc.cmdline} ` +
    `pid=${proc.pid} pod=${c.pod} ns=${ctx.namespace} container_id=${c.containerId} image=${c.image})`;
  return {
    time: falcoTimestamp(ctx.start, spec.offsetMs, ctx.rng),
    rule: rule.rule,
    priority: rule.priority,
    output,
    hostname: c.hostname,
    tags: spec.tags ?? rule.tags,
    output_fields: {
      [FIELDS.namespace]: ctx.namespace,
      [FIELDS.pod]: c.pod,
      [FIELDS.containerId]: c.containerId,
      [FIELDS.containerName]: c.containerName,
      [FIELDS.image]: c.image,
      [FIELDS.procName]: proc.name,
      [FIELDS.procCmdline]: proc.cmdline,
      [FIELDS.procPid]: proc.pid,
      [FIELDS.procPpid]: proc.ppid,
      [FIELDS.procPname]: proc.pname,
      [FIELDS.user]: user,
      ...extraFields,
    },
  };
}

export function accepted(offsetMs: number, event: Record<string, unknown>): SimItem {
  return { offsetMs, body: JSON.stringify(event), expect: 'accepted', label: String(event.rule) };
}
