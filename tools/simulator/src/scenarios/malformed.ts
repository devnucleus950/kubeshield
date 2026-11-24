// Six invalid payloads. The API must reject every one of them (400, or 413 for the oversized one).
import { falcoEvent, makeContainer } from '../events.js';
import { RULES } from '../rules.js';
import type { Scenario, SimItem } from '../scenario.js';

export const malformed: Scenario = {
  name: 'malformed',
  description: 'Six invalid payloads that must all be rejected (missing rule, bad time, wrong types, empty body, oversized, unknown priority)',
  build(ctx) {
    const c = makeContainer(ctx.rng);
    const valid = () =>
      falcoEvent(ctx, {
        rule: RULES.shell, container: c, offsetMs: 0,
        proc: { name: 'bash', cmdline: 'bash', pid: 4182, ppid: 4170, pname: 'runc:[2:INIT]' },
      });
    const without = (key: string) => {
      const e = valid();
      delete e[key];
      return e;
    };
    const item = (label: string, body: string): SimItem => ({ offsetMs: 0, body, expect: 'rejected', label });

    return [
      item('missing rule', JSON.stringify(without('rule'))),
      item('bad time', JSON.stringify({ ...valid(), time: 'yesterday afternoon' })),
      item('wrong types', JSON.stringify({ ...valid(), rule: 42, tags: 'not-a-list', output_fields: [1, 2, 3] })),
      item('empty body', ''),
      item('oversized body (1.2 MB)', JSON.stringify({ ...valid(), padding: 'x'.repeat(1_258_291) })),
      item('unknown priority', JSON.stringify({ ...valid(), priority: 'Catastrophic' })),
    ];
  },
};
