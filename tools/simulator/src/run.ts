// Sends a plan on a timeline and checks every response against what we expected.
import type { PlanItem } from './plan.js';
import type { SendResult } from './client.js';

// When each item is sent, in ms from the start. With a rate, items go out evenly
// (compressing or stretching time). Without one, they follow their natural offsets.
export function sendTimes(items: readonly { offsetMs: number }[], rate?: number): number[] {
  if (rate === undefined) return items.map((i) => i.offsetMs);
  return items.map((_, i) => (i * 1000) / rate);
}

// accepted -> 202. rejected -> 400 (invalid) or 413 (too large).
export function meetsExpectation(expect: PlanItem['expect'], status: number | null): boolean {
  if (status === null) return false;
  return expect === 'accepted' ? status === 202 : status === 400 || status === 413;
}

export interface Outcome {
  item: PlanItem;
  result: SendResult;
  ok: boolean;
}

export interface RunDeps {
  send: (body: string) => Promise<SendResult>;
  rate?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  maxInFlight?: number;
  onOutcome?: (o: Outcome, sentAtMs: number) => void;
}

export async function execute(items: readonly PlanItem[], deps: RunDeps): Promise<Outcome[]> {
  const now = deps.now ?? (() => performance.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxInFlight = deps.maxInFlight ?? 50;
  const times = sendTimes(items, deps.rate);
  const outcomes: Outcome[] = new Array(items.length);
  const inFlight = new Set<Promise<void>>();
  const t0 = now();

  for (let i = 0; i < items.length; i++) {
    const wait = t0 + times[i]! - now();
    if (wait > 0) await sleep(wait); // if we are behind schedule, send immediately (catch up)
    if (inFlight.size >= maxInFlight) await Promise.race(inFlight);

    const item = items[i]!;
    const sentAt = now() - t0;
    const p: Promise<void> = deps.send(item.body).then((result) => {
      const outcome = { item, result, ok: meetsExpectation(item.expect, result.status) };
      outcomes[i] = outcome;
      deps.onOutcome?.(outcome, sentAt);
    });
    inFlight.add(p);
    void p.finally(() => inFlight.delete(p));
  }
  await Promise.all(inFlight);
  return outcomes;
}

export function summarize(outcomes: readonly Outcome[]): { byStatus: Map<string, number>; failed: Outcome[] } {
  const byStatus = new Map<string, number>();
  for (const o of outcomes) {
    const key = o.result.status === null ? 'no response' : String(o.result.status);
    byStatus.set(key, (byStatus.get(key) ?? 0) + 1);
  }
  return { byStatus, failed: outcomes.filter((o) => !o.ok) };
}
