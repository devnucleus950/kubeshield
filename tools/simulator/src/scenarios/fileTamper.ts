import { accepted, falcoEvent, makeContainer } from '../events.js';
import { FIELDS, RULES } from '../rules.js';
import type { Scenario } from '../scenario.js';

export const fileTamper: Scenario = {
  name: 'file-tamper',
  description: 'Write under /etc, write to a system binary directory, change a cron file (3 events, ~5 s)',
  build(ctx) {
    const { rng } = ctx;
    const c = makeContainer(rng);
    const shellPid = rng.int(5000, 9000);
    const pids = [shellPid + rng.int(1, 20), shellPid + rng.int(21, 40), shellPid + rng.int(41, 60)] as const;
    const proc = (name: string, cmdline: string, pid: number) => ({ name, cmdline, pid, ppid: shellPid, pname: 'sh' });

    return [
      accepted(0, falcoEvent(ctx, {
        rule: RULES.writeEtc, container: c, offsetMs: 0,
        proc: proc('vi', 'vi /etc/passwd', pids[0]),
        extraFields: { [FIELDS.fdName]: '/etc/passwd' },
      })),
      accepted(2000, falcoEvent(ctx, {
        rule: RULES.writeBin, container: c, offsetMs: 2000,
        proc: proc('cp', 'cp /tmp/backdoor /usr/bin/updatedb', pids[1]),
        extraFields: { [FIELDS.fdName]: '/usr/bin/updatedb' },
      })),
      accepted(5000, falcoEvent(ctx, {
        rule: RULES.cron, container: c, offsetMs: 5000,
        proc: proc('crontab', 'crontab -e', pids[2]),
        extraFields: { [FIELDS.fdName]: '/etc/cron.d/persist' },
      })),
    ];
  },
};
