// Turns "run this scenario N times" into one ordered list of things to send.
import { createRng } from './rng.js';
import type { Scenario, SimItem } from './scenario.js';

export interface PlanItem extends SimItem {
  run: number; // which repetition (0-based); each run uses its own new pod
}

export interface PlanOptions {
  count: number;
  seed: number;
  namespace: string;
  start: Date;
}

const STAGGER_MS = 1000; // runs begin a little apart, like separate incidents

export function buildPlan(scenario: Scenario, opts: PlanOptions): PlanItem[] {
  const master = createRng(opts.seed);
  const items: PlanItem[] = [];
  for (let run = 0; run < opts.count; run++) {
    const rng = master.fork(); // each run gets its own pod, IPs and pids
    const stagger = run * STAGGER_MS + (run > 0 ? rng.int(0, 500) : 0);
    // Shift the run's clock too, so `time` inside each event matches when it is sent.
    const start = new Date(opts.start.getTime() + stagger);
    for (const item of scenario.build({ rng, namespace: opts.namespace, start })) {
      items.push({ ...item, offsetMs: item.offsetMs + stagger, run });
    }
  }
  return items.sort((a, b) => a.offsetMs - b.offsetMs); // stable: ties keep their order
}
