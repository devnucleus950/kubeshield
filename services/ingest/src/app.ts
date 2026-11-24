// Builds the Express app and returns it WITHOUT calling listen, so tests can
// call the API without opening a port. server.ts is what listens.
import express, { type Express } from 'express';
import helmet from 'helmet';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import type { Logger } from 'pino';
import type { IngestConfig } from '@kubeshield/shared';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { requestId } from './middleware/requestId.js';
import { eventsRouter } from './routes/events.js';
import { healthRouter } from './routes/health.js';

export interface AppDeps {
  config: IngestConfig;
  redis: Redis;
  pool: pg.Pool;
  logger: Logger;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestId(deps.logger));
  app.use(helmet()); // security headers. CORS stays off in this phase.
  app.use(healthRouter(deps));
  app.use(eventsRouter(deps));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
