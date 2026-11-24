import { describe, expect, it } from 'vitest';
import { falcoEventSchema } from './falco.js';
import { sampleFalcoEvent } from './fixtures.js';
import { normalize, priorityRank } from './normalized.js';

const ID = '11111111-1111-4111-8111-111111111111';
const RECEIVED = '2026-11-24T10:31:08.000Z';
const run = (overrides: Record<string, unknown> = {}) =>
  normalize(falcoEventSchema.parse(sampleFalcoEvent(overrides)), ID, RECEIVED);

describe('normalize', () => {
  it('maps every field of a valid event', () => {
    const n = run();
    expect(n).toMatchObject({
      event_id: ID,
      occurred_at: '2026-11-24T10:31:07.123Z',
      received_at: RECEIVED,
      rule: 'Terminal shell in container',
      priority: 'Notice',
      priority_rank: 5,
      tags: ['container', 'shell', 'mitre_execution'],
      hostname: 'kubeshield-worker',
      namespace: 'production',
      pod: 'payments-7d9f-xk2lp',
      container_id: 'a1b2c3d4e5f6',
      container_name: 'payments',
      image: 'acme/payments',
      proc_name: 'bash',
      proc_cmdline: 'bash',
      proc_pid: 4182,
      proc_ppid: 4170,
      user_name: 'root',
      file_path: null,
      remote_ip: null,
      remote_port: null,
    });
    expect(n.raw).toMatchObject({ rule: 'Terminal shell in container' });
  });

  it('gives null, not an error, when k8s.pod.name is missing', () => {
    const fields = { ...(sampleFalcoEvent().output_fields as object) } as Record<string, unknown>;
    delete fields['k8s.pod.name'];
    const n = run({ output_fields: fields });
    expect(n.pod).toBeNull();
    expect(n.namespace).toBe('production');
  });

  it('gives null for every optional field when output_fields is empty', () => {
    const n = run({ output_fields: {}, hostname: undefined });
    expect(n.hostname).toBeNull();
    expect(n.container_id).toBeNull();
    expect(n.proc_pid).toBeNull();
  });

  it('puts a file path in file_path and leaves remote_ip null', () => {
    const n = run({ output_fields: { 'fd.name': '/etc/shadow' } });
    expect(n.file_path).toBe('/etc/shadow');
    expect(n.remote_ip).toBeNull();
  });

  it('fills remote_ip and remote_port for a network event, with no file_path', () => {
    const n = run({
      output_fields: { 'fd.name': '10.0.0.5:41234->203.0.113.9:4444', 'fd.sip': '203.0.113.9', 'fd.sport': 4444 },
    });
    expect(n.remote_ip).toBe('203.0.113.9');
    expect(n.remote_port).toBe(4444);
    expect(n.file_path).toBeNull();
  });

  it('falls back to fd.rip and accepts numbers sent as strings', () => {
    const n = run({ output_fields: { 'fd.rip': '198.51.100.7', 'proc.pid': '77' } });
    expect(n.remote_ip).toBe('198.51.100.7');
    expect(n.proc_pid).toBe(77);
  });

  it('ignores wrongly-typed field values instead of throwing', () => {
    const n = run({ output_fields: { 'proc.pid': { evil: true }, 'proc.name': 99, 'container.id': '' } });
    expect(n.proc_pid).toBeNull();
    expect(n.proc_name).toBeNull();
    expect(n.container_id).toBeNull();
  });

  it('ranks priorities from Emergency (0) to Debug (7)', () => {
    expect(priorityRank('Emergency')).toBe(0);
    expect(priorityRank('Critical')).toBe(2);
    expect(priorityRank('Debug')).toBe(7);
  });
});
