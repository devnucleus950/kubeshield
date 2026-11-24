// Starts the ingest API and shuts it down cleanly on SIGINT / SIGTERM.
import { Redis } from 'ioredis';
import pg from 'pg';
import { pino } from 'pino';
import { ingestConfigSchema, loadConfigOrExit } from '@kubeshield/shared';
import { createApp } from './app.js';

const config = loadConfigOrExit(ingestConfigSchema);
const logger = pino({ level: config.LOG_LEVEL, base: { service: 'ingest' } });

const redis = new Redis(config.REDIS_URL, {
  // Fail fast while Redis is down so the API can answer 503, instead of
  // queueing commands and leaving the caller hanging.
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  commandTimeout: 3000,
});
redis.on('error', (err) => logger.warn({ err: err.message }, 'redis error'));
redis.on('ready', () => logger.info('redis connected'));

const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 5 });
pool.on('error', (err) => logger.warn({ err: err.message }, 'postgres pool error'));

const app = createApp({ config, redis, pool, logger });
const server = app.listen(config.INGEST_PORT, config.INGEST_HOST, () => {
  logger.info({ host: config.INGEST_HOST, port: config.INGEST_PORT }, 'ingest listening');
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');

  // Give in-flight requests up to 10 seconds, then cut the rest.
  const force = setTimeout(() => {
    logger.warn('forcing shutdown after 10s');
    server.closeAllConnections();
  }, 10_000);
  force.unref();

  server.close(async () => {
    clearTimeout(force);
    await Promise.allSettled([redis.quit(), pool.end()]);
    logger.info('shutdown complete');
    process.exit(0);
  });
  server.closeIdleConnections();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
