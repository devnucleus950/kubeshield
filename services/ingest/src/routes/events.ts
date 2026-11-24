// Routes only parse the request, call a function and return the result.
import express, { Router } from 'express';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { streamNames, type IngestConfig } from '@kubeshield/shared';
import { HttpError } from '../errors.js';
import { apiKey } from '../middleware/apiKey.js';
import { publishEvents, validateBody } from '../ingest.js';
import { latestEvents } from '../queries.js';

export const MAX_BODY_BYTES = 1024 * 1024; // 1 MB

export function eventsRouter(deps: { config: IngestConfig; redis: Redis; pool: pg.Pool }): Router {
  const { config, redis, pool } = deps;
  const stream = streamNames(config.STREAM_PREFIX).raw;
  const router = Router();

  // Step 1 of the spec: reject oversized bodies first. Content-Length lets us
  // refuse without reading them; express.json below enforces the same limit
  // for chunked bodies that send no Content-Length.
  const rejectOversize: express.RequestHandler = (req, _res, next) => {
    if (Number(req.header('content-length') ?? 0) > MAX_BODY_BYTES) {
      throw new HttpError(413, 'payload_too_large', 'Request body is too large (limit 1 MB)');
    }
    next();
  };

  router.post(
    '/v1/events',
    rejectOversize,
    apiKey(config.INGEST_API_KEY),
    express.json({ limit: MAX_BODY_BYTES }),
    async (req, res) => {
      const events = validateBody(req.body);
      const { eventIds } = await publishEvents(redis, stream, config.STREAM_MAXLEN, events);
      req.log.info(
        { accepted: events.length, events: events.map((e, i) => ({ event_id: eventIds[i], rule: e.rule })) },
        'events accepted',
      );
      res.status(202).json({ accepted: events.length, event_ids: eventIds });
    },
  );

  // Dev-only: look at what the worker has stored. Moves or goes away in Phase 4.
  router.get('/v1/events', apiKey(config.INGEST_API_KEY), async (req, res) => {
    const raw = req.query.limit;
    const limit = raw === undefined ? 50 : Number(raw);
    if (typeof raw === 'object' || !Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new HttpError(400, 'invalid_query', 'limit must be an integer from 1 to 500');
    }
    res.json({ events: await latestEvents(pool, limit) });
  });

  return router;
}
