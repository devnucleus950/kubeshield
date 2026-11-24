// Takes over messages stuck with a worker that died and never came back.
// Uses XAUTOCLAIM: "give me everything that has been pending longer than X".
import type { Ctx } from './batch.js';
import type { Entry } from './batch.js';
import { autoClaim } from './streamIo.js';

export interface ReclaimOptions {
  consumer: string;
  minIdleMs: number;
  batchSize: number;
  // Runs the same process-and-acknowledge path as normal reads (with retries).
  process: (entries: Entry[], redelivered: boolean) => Promise<void>;
}

export async function reclaimStuck(ctx: Ctx, opts: ReclaimOptions): Promise<number> {
  let cursor = '0-0';
  let total = 0;
  do {
    const { next, entries } = await autoClaim(
      ctx.redis, ctx.names, opts.consumer, opts.minIdleMs, cursor, opts.batchSize,
    );
    if (entries.length > 0) {
      ctx.logger.info({ count: entries.length }, 'reclaimed stuck messages');
      await opts.process(entries, true);
      total += entries.length;
    }
    cursor = next;
  } while (cursor !== '0-0');
  return total;
}
