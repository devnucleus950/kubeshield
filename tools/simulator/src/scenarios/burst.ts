import { accepted, falcoEvent, makeContainer } from '../events.js';
import { FIELDS, RULES } from '../rules.js';
import type { Scenario } from '../scenario.js';

export const burst: Scenario = {
  name: 'burst',
  description: 'One low-priority event type, 500 events at high speed, for load testing (default 100/s)',
  defaultRate: 100,
  build(ctx) {
    const { rng } = ctx;
    const c = makeContainer(rng);
    const basePid = rng.int(10_000, 20_000);
    return Array.from({ length: 500 }, (_, i) =>
      accepted(0, falcoEvent(ctx, {
        rule: RULES.configRead, container: c, offsetMs: 0,
        proc: { name: 'cat', cmdline: 'cat /app/config.yaml', pid: basePid + i, ppid: 1, pname: 'sh' },
        extraFields: { [FIELDS.fdName]: '/app/config.yaml' },
      })),
    );
  },
};
