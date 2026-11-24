// Harmless noise across three pods. Proves normal activity is not treated as an attack.
import { accepted, falcoEvent, makeContainer, type Container } from '../events.js';
import { FIELDS, RULES } from '../rules.js';
import type { Scenario } from '../scenario.js';

const SPAN_MS = 30_000;

export const baseline: Scenario = {
  name: 'baseline',
  description: 'Low-priority background noise: package manager runs and config reads (20-50 events over ~30 s)',
  build(ctx) {
    const { rng } = ctx;
    const pods: Container[] = [makeContainer(rng), makeContainer(rng), makeContainer(rng)];
    const count = rng.int(20, 50);
    const offsets = Array.from({ length: count }, () => rng.int(0, SPAN_MS)).sort((a, b) => a - b);

    return offsets.map((offsetMs) => {
      const c = rng.pick(pods);
      const pid = rng.int(10_000, 30_000);
      const kind = rng.int(0, 2);
      if (kind === 0) {
        const cmd = rng.pick(['apt-get update', 'apt-get install -y ca-certificates', 'pip install --upgrade pip']);
        return accepted(offsetMs, falcoEvent(ctx, {
          rule: RULES.packageManager, container: c, offsetMs,
          proc: { name: cmd.split(' ')[0]!, cmdline: cmd, pid, ppid: 1, pname: 'sh' },
        }));
      }
      if (kind === 1) {
        const path = rng.pick(['/app/config.yaml', '/etc/app/settings.json', '/etc/resolv.conf', '/app/.env.defaults']);
        return accepted(offsetMs, falcoEvent(ctx, {
          rule: RULES.configRead, container: c, offsetMs,
          proc: { name: 'node', cmdline: 'node server.js', pid, ppid: 1, pname: 'sh' },
          extraFields: { [FIELDS.fdName]: path },
        }));
      }
      return accepted(offsetMs, falcoEvent(ctx, {
        rule: RULES.dns, container: c, offsetMs,
        proc: { name: 'node', cmdline: 'node server.js', pid, ppid: 1, pname: 'sh' },
      }));
    });
  },
};
