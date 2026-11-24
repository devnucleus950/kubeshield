import { Router } from 'express';
import type { Redis } from 'ioredis';
import type pg from 'pg';

const PING_TIMEOUT_MS = 2000;

function withTimeout<T>(p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), PING_TIMEOUT_MS).unref()),
  ]);
}

export function healthRouter(deps: { redis: Redis; pool: pg.Pool }): Router {
  const router = Router();

  // Liveness: the process is running.
  router.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Readiness: Redis and Postgres both answer a ping.
  router.get('/readyz', async (_req, res) => {
    const [redis, postgres] = await Promise.allSettled([
      withTimeout(deps.redis.ping()),
      withTimeout(deps.pool.query('SELECT 1')),
    ]);
    const status = {
      redis: redis.status === 'fulfilled' ? 'ok' : 'down',
      postgres: postgres.status === 'fulfilled' ? 'ok' : 'down',
    };
    const ready = status.redis === 'ok' && status.postgres === 'ok';
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', ...status });
  });

  return router;
}
