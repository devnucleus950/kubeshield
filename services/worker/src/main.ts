// Starts the worker and shuts it down cleanly on SIGINT / SIGTERM.
import { Redis } from 'ioredis';
import pg from 'pg';
import { pino } from 'pino';
import { loadConfigOrExit, workerConfigSchema } from '@kubeshield/shared';
import { Consumer } from './consumer.js';

const config = loadConfigOrExit(workerConfigSchema);
const logger = pino({ level: config.LOG_LEVEL, base: { service: 'worker' } });

const redis = new Redis(config.REDIS_URL, {
  // Wait for Redis forever instead of failing commands: the worker just resumes when it returns.
  maxRetriesPerRequest: null,
});
redis.on('error', (err) => logger.warn({ err: err.message }, 'redis error'));
redis.on('ready', () => logger.info('redis connected'));

const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 4 });
pool.on('error', (err) => logger.warn({ err: err.message }, 'postgres pool error'));

const consumer = new Consumer({ config, redis, pool, logger });
consumer.start();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');

  // Hard stop after 15 seconds, whatever is still running.
  setTimeout(() => {
    logger.error('forced exit after 15s');
    process.exit(1);
  }, 15_000).unref();

  await consumer.stop(); // finishes and acknowledges the current batch
  await Promise.allSettled([redis.quit(), pool.end()]);
  logger.info('shutdown complete');
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
