// A valid raw Falco event (the example from section 6.1), for tests and the simulator.
import type { FalcoEvent } from './falco.js';

export function sampleFalcoEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    time: '2026-11-24T10:31:07.123456789Z',
    rule: 'Terminal shell in container',
    priority: 'Notice',
    output: 'A shell was spawned in a container with an attached terminal',
    hostname: 'kubeshield-worker',
    tags: ['container', 'shell', 'mitre_execution'],
    output_fields: {
      'k8s.ns.name': 'production',
      'k8s.pod.name': 'payments-7d9f-xk2lp',
      'container.id': 'a1b2c3d4e5f6',
      'container.name': 'payments',
      'container.image.repository': 'acme/payments',
      'proc.name': 'bash',
      'proc.cmdline': 'bash',
      'proc.pid': 4182,
      'proc.ppid': 4170,
      'proc.pname': 'runc:[2:INIT]',
      'user.name': 'root',
    },
    ...overrides,
  };
}

export type { FalcoEvent };
