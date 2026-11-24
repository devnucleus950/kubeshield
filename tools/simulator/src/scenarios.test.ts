import { describe, expect, it } from 'vitest';
import { falcoEventSchema, normalize, PRIORITIES } from '@kubeshield/shared';
import { buildPlan, type PlanItem } from './plan.js';
import { seedFrom } from './rng.js';
import { execute, meetsExpectation, sendTimes } from './run.js';
import { SCENARIOS, findScenario } from './scenarios/index.js';

const START = new Date('2026-11-24T10:00:00.000Z');
const plan = (name: string, opts: { count?: number; seed?: number } = {}): PlanItem[] =>
  buildPlan(findScenario(name)!, { count: opts.count ?? 1, seed: opts.seed ?? 42, namespace: 'production', start: START });
const events = (items: PlanItem[]) => items.map((i) => JSON.parse(i.body));

describe('every scenario that should be accepted produces schema-valid events', () => {
  for (const scenario of SCENARIOS.filter((s) => s.name !== 'malformed')) {
    it(scenario.name, () => {
      const items = plan(scenario.name);
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        expect(item.expect).toBe('accepted');
        const parsed = falcoEventSchema.safeParse(JSON.parse(item.body));
        expect(parsed.success, `${item.label}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
        // and they normalize cleanly, as the worker will do
        if (parsed.success) expect(() => normalize(parsed.data, '11111111-1111-4111-8111-111111111111', START.toISOString())).not.toThrow();
      }
    });
  }
});

describe('shell-attack', () => {
  const items = plan('shell-attack');
  const [shell, tool, read, out] = events(items);
  const f = (e: Record<string, any>) => e.output_fields as Record<string, any>;

  it('has four events at T+0, 3, 7 and 11 seconds with the specified rules', () => {
    expect(items.map((i) => i.offsetMs)).toEqual([0, 3000, 7000, 11000]);
    expect(items.map((i) => i.label)).toEqual([
      'Terminal shell in container',
      'Launch Suspicious Network Tool in Container',
      'Read sensitive file untrusted',
      'Unexpected outbound connection destination',
    ]);
  });

  it('timestamps reflect the intended offsets', () => {
    const ms = [shell, tool, read, out].map((e) => Date.parse(e.time) - START.getTime());
    expect(ms).toEqual([0, 3000, 7000, 11000]);
  });

  it('shares one container, pod and image across all four', () => {
    for (const key of ['container.id', 'k8s.pod.name', 'container.image.repository']) {
      expect(new Set([shell, tool, read, out].map((e) => f(e)[key])).size).toBe(1);
    }
  });

  it('keeps a consistent process tree: curl, cat and curl are all children of the first bash', () => {
    expect(f(shell)['proc.name']).toBe('bash');
    expect(f(shell)['proc.pname']).toBe('runc:[2:INIT]');
    const bashPid = f(shell)['proc.pid'];
    for (const child of [tool, read, out]) expect(f(child)['proc.ppid']).toBe(bashPid);
    expect(f(tool)['proc.name']).toBe('curl');
    expect(f(read)['proc.name']).toBe('cat');
    expect(f(out)['proc.name']).toBe('curl');
    expect(new Set([bashPid, f(tool)['proc.pid'], f(read)['proc.pid'], f(out)['proc.pid']]).size).toBe(4);
  });

  it('reads /etc/shadow and connects out to a public-range IP on port 4444', () => {
    expect(f(read)['fd.name']).toBe('/etc/shadow');
    expect(f(out)['fd.sport']).toBe(4444);
    expect(f(out)['fd.sip']).toMatch(/^(203\.0\.113|198\.51\.100|192\.0\.2)\.\d+$/);
  });

  it('escalates priority strictly from Notice to Critical', () => {
    const ranks = [shell, tool, read, out].map((e) => PRIORITIES.indexOf(e.priority));
    expect(shell.priority).toBe('Notice');
    expect(out.priority).toBe('Critical');
    for (let i = 1; i < ranks.length; i++) expect(ranks[i]).toBeLessThan(ranks[i - 1]!);
  });

  it('tags execution, credential access and command and control', () => {
    const tags = [shell, tool, read, out].flatMap((e) => e.tags);
    expect(tags).toEqual(expect.arrayContaining(['mitre_execution', 'mitre_credential_access', 'mitre_command_and_control']));
  });

  it('normalizes so the network event fills remote_ip and the file event fills file_path', () => {
    const n = (e: unknown) => normalize(falcoEventSchema.parse(e), '11111111-1111-4111-8111-111111111111', START.toISOString());
    expect(n(read).file_path).toBe('/etc/shadow');
    expect(n(out).remote_port).toBe(4444);
    expect(n(out).file_path).toBeNull();
  });
});

describe('other scenarios', () => {
  it('baseline: 20 to 50 events, low priority, spread over exactly 3 pods', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const evs = events(plan('baseline', { seed }));
      expect(evs.length).toBeGreaterThanOrEqual(20);
      expect(evs.length).toBeLessThanOrEqual(50);
      for (const e of evs) expect(PRIORITIES.indexOf(e.priority)).toBeGreaterThanOrEqual(PRIORITIES.indexOf('Notice'));
      expect(new Set(evs.map((e) => e.output_fields['k8s.pod.name'])).size).toBeLessThanOrEqual(3);
      expect(evs.flatMap((e) => e.tags).join(',')).not.toMatch(/mitre/);
    }
  });

  it('privileged-container: one event', () => {
    const evs = events(plan('privileged-container'));
    expect(evs).toHaveLength(1);
    expect(evs[0].rule).toBe('Launch Privileged Container');
    expect(evs[0].output_fields['container.privileged']).toBe(true);
  });

  it('file-tamper: etc, binary dir and cron, in that order', () => {
    const evs = events(plan('file-tamper'));
    expect(evs.map((e) => e.output_fields['fd.name'])).toEqual(['/etc/passwd', '/usr/bin/updatedb', '/etc/cron.d/persist']);
  });

  it('burst: 500 events of one rule, defaulting to 100 per second', () => {
    const items = plan('burst');
    expect(items).toHaveLength(500);
    expect(new Set(events(items).map((e) => e.rule)).size).toBe(1);
    expect(findScenario('burst')!.defaultRate).toBe(100);
  });
});

describe('malformed', () => {
  const items = plan('malformed');
  it('has six payloads, all expected to be rejected', () => {
    expect(items).toHaveLength(6);
    expect(items.every((i) => i.expect === 'rejected')).toBe(true);
  });
  it('every payload really fails the Falco schema (or is not even JSON), except the oversized one, which is rejected for its size', () => {
    for (const item of items.filter((i) => i.body.length <= 1024 * 1024)) {
      let valid = false;
      try {
        valid = falcoEventSchema.safeParse(JSON.parse(item.body)).success;
      } catch {
        valid = false;
      }
      expect(valid, item.label).toBe(false);
    }
  });
  it('includes an empty body and one over 1 MB', () => {
    expect(items.some((i) => i.body === '')).toBe(true);
    expect(items.some((i) => i.body.length > 1024 * 1024)).toBe(true);
  });
});

describe('reproducibility and runs', () => {
  it('the same seed gives byte-identical events', () => {
    expect(plan('shell-attack', { seed: 7 })).toEqual(plan('shell-attack', { seed: 7 }));
  });
  it('different seeds give different pods', () => {
    const pod = (seed: number) => events(plan('shell-attack', { seed }))[0].output_fields['k8s.pod.name'];
    expect(pod(1)).not.toBe(pod(2));
  });
  it('--count runs the scenario several times, each on a new pod', () => {
    const items = plan('shell-attack', { count: 3 });
    expect(items).toHaveLength(12);
    const pods = new Set(events(items).map((e) => e.output_fields['k8s.pod.name']));
    expect(pods.size).toBe(3);
    expect(items.map((i) => i.offsetMs)).toEqual([...items.map((i) => i.offsetMs)].sort((a, b) => a - b));
  });
  it('text seeds work too', () => {
    expect(seedFrom('demo')).toBe(seedFrom('demo'));
    expect(seedFrom('demo')).not.toBe(seedFrom('other'));
    expect(seedFrom('42')).toBe(42);
  });
});

describe('timeline and expectations', () => {
  it('natural timing follows offsets; --rate spaces events evenly', () => {
    const items = [{ offsetMs: 0 }, { offsetMs: 3000 }, { offsetMs: 7000 }];
    expect(sendTimes(items)).toEqual([0, 3000, 7000]);
    expect(sendTimes(items, 2)).toEqual([0, 500, 1000]);
  });
  it('accepted means 202; rejected means 400 or 413', () => {
    expect(meetsExpectation('accepted', 202)).toBe(true);
    expect(meetsExpectation('accepted', 400)).toBe(false);
    expect(meetsExpectation('rejected', 400)).toBe(true);
    expect(meetsExpectation('rejected', 413)).toBe(true);
    expect(meetsExpectation('rejected', 202)).toBe(false);
    expect(meetsExpectation('rejected', 401)).toBe(false);
    expect(meetsExpectation('accepted', null)).toBe(false);
  });
  it('execute sends in order on the planned timeline and flags mismatches', async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const items = plan('file-tamper');
    const sent: string[] = [];
    const outcomes = await execute(items, {
      now: () => clock,
      sleep: async (ms) => { sleeps.push(ms); clock += ms; },
      send: async (body) => { sent.push(JSON.parse(body).rule); return { status: sent.length === 2 ? 500 : 202 }; },
    });
    expect(sent).toEqual(['Write below etc', 'Write below binary dir', 'Schedule Cron Jobs']);
    expect(sleeps).toEqual([2000, 3000]); // 0 -> 2s -> 5s
    expect(outcomes.map((o) => o.ok)).toEqual([true, false, true]);
  });
});
