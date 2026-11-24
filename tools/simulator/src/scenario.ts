// The shapes shared by every scenario.
import type { Rng } from './rng.js';

// One thing to send. `body` is the raw request body, because the malformed
// scenario needs bodies that are not valid JSON (or not even there).
export interface SimItem {
  offsetMs: number; // when it "happened", relative to the start of its run
  body: string;
  expect: 'accepted' | 'rejected';
  label: string;
}

export interface ScenarioContext {
  rng: Rng;
  namespace: string;
  start: Date; // the instant offsets are measured from
}

export interface Scenario {
  name: string;
  description: string;
  defaultRate?: number; // events per second when --rate is not given (otherwise: natural timing)
  build(ctx: ScenarioContext): SimItem[]; // one run of the scenario
}
