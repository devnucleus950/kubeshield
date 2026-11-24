// Contract 1 (section 6.1): the raw Falco event, exactly as it arrives at the API.
// Lenient on purpose: we require the fields we depend on and keep everything
// else, because real Falco versions add fields.
import { z } from 'zod';

// Index in this list is the priority_rank: 0 = Emergency ... 7 = Debug.
export const PRIORITIES = [
  'Emergency',
  'Alert',
  'Critical',
  'Error',
  'Warning',
  'Notice',
  'Informational',
  'Debug',
] as const;

export type Priority = (typeof PRIORITIES)[number];

// The events come from the network, so even valid-looking fields get a size
// cap. A security tool must not accept a 50 MB "rule name".
export const falcoEventSchema = z.looseObject({
  time: z.iso
    .datetime({ offset: true })
    .refine((t) => !Number.isNaN(Date.parse(t)), 'not a real date'),
  rule: z.string().min(1).max(512),
  priority: z.enum(PRIORITIES),
  output: z.string().max(16_384),
  hostname: z.string().max(512).optional(),
  tags: z.array(z.string().max(256)).max(64).default([]),
  output_fields: z.record(z.string(), z.unknown()).default({}),
});

export type FalcoEvent = z.infer<typeof falcoEventSchema>;
