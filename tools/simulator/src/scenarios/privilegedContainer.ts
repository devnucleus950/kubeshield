import { accepted, falcoEvent, makeContainer } from '../events.js';
import { FIELDS, RULES } from '../rules.js';
import type { Scenario } from '../scenario.js';

export const privilegedContainer: Scenario = {
  name: 'privileged-container',
  description: 'A container started in privileged mode (1 event)',
  build(ctx) {
    const c = makeContainer(ctx.rng);
    const event = falcoEvent(ctx, {
      rule: RULES.privileged, container: c, offsetMs: 0,
      proc: { name: 'runc', cmdline: `runc run ${c.containerId}`, pid: ctx.rng.int(3000, 9000), ppid: 1, pname: 'containerd-shim' },
      extraFields: { [FIELDS.containerPrivileged]: true },
    });
    return [accepted(0, event)];
  },
};
