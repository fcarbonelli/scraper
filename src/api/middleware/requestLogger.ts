/**
 * Per-request structured logger.
 *
 * Logs method, path, status, duration, and the (already-validated) API key
 * name if present. Skips noisy /health checks at info level.
 */

import type { NextFunction, Request, Response } from 'express';
import { logger } from '../../shared/logger.js';

export function requestLogger(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const start = Date.now();

  res.on('finish', () => {
    const durationMs = Date.now() - start;
    const log = logger.child({
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs,
      ...(req.apiKey ? { apiKey: req.apiKey.name } : {}),
    });
    // Health checks happen often; demote them so real traffic is visible.
    const level =
      req.path === '/v1/health' ? 'debug'
      : res.statusCode >= 500 ? 'error'
      : res.statusCode >= 400 ? 'warn'
      : 'info';
    log[level]('request');
  });

  next();
}
