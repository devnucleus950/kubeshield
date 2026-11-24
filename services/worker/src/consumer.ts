// The worker's main loop: read, process, acknowledge, forever.
import { hostname } from 'node:os';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import type { Logger } from 'pino';
import { streamNames, type StreamNames, type WorkerConfig } from '@kubeshield/shared';
import { processBatch, type Ctx, type Entry } from './batch.js';
import { reclaimStuck } from './reclaim.js';
import { ensureGroup, readNew, readOwnPending } from './streamIo.js';

export interface ConsumerOptions {
  config: WorkerConfig;
  redis: Redis;
  pool: pg.Pool;
  logger: Logger;
  consumerName?: string;
  backoff?: { minMs: number; maxMs: number }; // defaults: 500 ms doubling up to 30 s
}

export function defaultConsumerName(): string {
  return `worker-${hostname()}-${process.pid}`;
}

export class Consumer {
  readonly name: string;
  private readonly ctx: Ctx;
  private readonly config: WorkerConfig;
  private readonly logger: Logger;
  private readonly backoffMin: number;
  private readonly backoffMax: number;
  private delay: number;
  private readonly abort = new AbortController();
  private loop: Promise<void> | null = null;

  constructor(opts: ConsumerOptions) {
    this.config = opts.config;
    this.logger = opts.logger;
    this.name = opts.consumerName ?? defaultConsumerName();
    this.backoffMin = opts.backoff?.minMs ?? 500;
    this.backoffMax = opts.backoff?.maxMs ?? 30_000;
    this.delay = this.backoffMin;
    this.ctx = {
      redis: opts.redis,
      pool: opts.pool,
      names: streamNames(opts.config.STREAM_PREFIX),
      maxDeliveries: opts.config.WORKER_MAX_DELIVERIES,
      logger: opts.logger,
    };
  }

  get names(): StreamNames {
    return this.ctx.names;
  }

  // Starts the loop in the background. Await stop() to shut down cleanly.
  start(): void {
    if (this.loop) throw new Error('already started');
    this.loop = this.run();
  }

  // Stop reading, let the current batch finish and be acknowledged, then return.
  async stop(): Promise<void> {
    this.abort.abort();
    await this.loop;
  }

  private get stopping(): boolean {
    return this.abort.signal.aborted;
  }

  // Waits, but wakes immediately on shutdown.
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.abort.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }

  private async waitBackoff(): Promise<void> {
    const wait = this.delay;
    this.delay = Math.min(this.delay * 2, this.backoffMax);
    await this.sleep(wait);
  }

  // Process one batch. If Postgres or Redis is unavailable, wait with exponential
  // backoff and retry the SAME in-memory batch. We do not re-read it from Redis,
  // so an outage can never use up a message's delivery limit.
  private async processWithRetry(entries: Entry[], redelivered: boolean): Promise<void> {
    while (!this.stopping) {
      try {
        const stats = await processBatch(this.ctx, entries, redelivered);
        this.delay = this.backoffMin;
        this.logger.info(stats, 'batch');
        return;
      } catch (err) {
        this.logger.warn({ err: (err as Error).message, retry_in_ms: this.delay }, 'batch failed, will retry');
        await this.waitBackoff();
      }
    }
    // Shutting down mid-retry: the entries stay pending in Redis, so nothing is lost.
  }

  // Messages delivered to this exact consumer name earlier and never acknowledged.
  private async drainOwnPending(): Promise<void> {
    for (;;) {
      const entries = await readOwnPending(this.ctx.redis, this.ctx.names, this.name, this.config.WORKER_BATCH_SIZE);
      if (entries.length === 0 || this.stopping) return;
      await this.processWithRetry(entries, true);
    }
  }

  private async run(): Promise<void> {
    this.logger.info({ consumer: this.name }, 'worker started');
    let lastReclaim = 0; // 0 = run a reclaim pass straight away at startup
    let ready = false;

    while (!this.stopping) {
      try {
        if (!ready) {
          await ensureGroup(this.ctx.redis, this.ctx.names);
          await this.drainOwnPending();
          ready = true;
        }
        if (Date.now() - lastReclaim >= this.config.WORKER_RECLAIM_INTERVAL_MS) {
          await reclaimStuck(this.ctx, {
            consumer: this.name,
            minIdleMs: this.config.WORKER_RECLAIM_IDLE_MS,
            batchSize: this.config.WORKER_BATCH_SIZE,
            process: (entries, redelivered) => this.processWithRetry(entries, redelivered),
          });
          lastReclaim = Date.now();
        }
        const entries = await readNew(
          this.ctx.redis, this.ctx.names, this.name, this.config.WORKER_BATCH_SIZE, this.config.WORKER_BLOCK_MS,
        );
        if (entries.length > 0) await this.processWithRetry(entries, false);
        this.delay = this.backoffMin;
      } catch (err) {
        if (this.stopping) break;
        const message = (err as Error).message;
        // The stream or group vanished (for example Redis lost its data): recreate on the next pass.
        if (message.includes('NOGROUP')) ready = false;
        this.logger.warn({ err: message, retry_in_ms: this.delay }, 'worker loop error, backing off');
        await this.waitBackoff();
      }
    }
    this.logger.info('worker loop stopped');
  }
}
