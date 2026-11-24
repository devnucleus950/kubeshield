import type { ErrorRequestHandler, RequestHandler } from 'express';
import { HttpError } from '../errors.js';

export const notFound: RequestHandler = (_req, _res, next) => {
  next(new HttpError(404, 'not_found', 'Not found'));
};

// Shape of the errors body-parser (express.json) throws.
interface BodyParserError {
  type?: string;
  status?: number;
}

export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, _next) => {
  let httpError: HttpError;

  if (err instanceof HttpError) {
    httpError = err;
  } else if ((err as BodyParserError)?.type === 'entity.too.large') {
    httpError = new HttpError(413, 'payload_too_large', 'Request body is too large (limit 1 MB)');
  } else if ((err as BodyParserError)?.type === 'entity.parse.failed') {
    httpError = new HttpError(400, 'invalid_json', 'Request body is not valid JSON');
  } else if (typeof (err as BodyParserError)?.type === 'string' && (err as BodyParserError).status === 415) {
    httpError = new HttpError(415, 'unsupported_media_type', 'Unsupported content encoding');
  } else {
    // Unknown failure: log the detail here, tell the client nothing. Never send a stack trace.
    req.log.error({ err }, 'unhandled error');
    httpError = new HttpError(500, 'internal_error', 'Internal server error');
  }

  for (const [name, value] of Object.entries(httpError.headers)) res.setHeader(name, value);
  const body: { error: { code: string; message: string; issues?: unknown } } = {
    error: { code: httpError.code, message: httpError.message },
  };
  if (httpError.issues) body.error.issues = httpError.issues;
  res.status(httpError.status).json(body);
};
