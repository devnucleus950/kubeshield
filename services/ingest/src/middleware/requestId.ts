import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Logger } from 'pino';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      id: string;
      log: Logger;
    }
  }
}

// A client-supplied id is reused, but only if it is short and boring, so it is
// safe to put in headers and logs. Otherwise we generate one.
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function requestId(logger: Logger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const supplied = req.header('x-request-id');
    req.id = supplied && SAFE_ID.test(supplied) ? supplied : randomUUID();
    res.setHeader('x-request-id', req.id);
    req.log = logger.child({ request_id: req.id });

    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      // Path only, never the query string, headers or body.
      req.log.info({ method: req.method, path: req.path, status: res.statusCode, ms: Math.round(ms) }, 'request');
    });
    next();
  };
}
