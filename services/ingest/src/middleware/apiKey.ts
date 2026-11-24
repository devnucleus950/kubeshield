import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { HttpError } from '../errors.js';

// Constant-time comparison: hash both sides to equal length first, so neither
// the timing nor the length of the real key leaks.
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function apiKey(expected: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const given = req.header('x-api-key');
    // Same response for "missing" and "wrong": no hint about which.
    if (!given || !safeEqual(given, expected)) {
      throw new HttpError(401, 'unauthorized', 'Missing or invalid API key');
    }
    next();
  };
}
