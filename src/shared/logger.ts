/**
 * Centralized structured logger.
 *
 * - In development: pretty-printed, colorized output via `pino-pretty`.
 * - In production: JSON one-line-per-event for log aggregators (PM2/CloudWatch).
 *
 * Always use `logger.child({ ... })` to add context. E.g. inside the worker:
 *     const log = logger.child({ supermarket: 'coto', sku: 'sku001' });
 *     log.info('starting scrape');
 */

import { pino, type Logger as PinoLogger, type LoggerOptions } from 'pino';
import { env, isDevelopment } from './env.js';

const baseOptions: LoggerOptions = {
  level: env.LOG_LEVEL,
  base: {
    // Attached to every log line; useful in production aggregators
    service: 'scraper',
    env: env.NODE_ENV,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Avoid logging anything that smells like a secret
  redact: {
    paths: [
      'headers.authorization',
      'headers["x-api-key"]',
      'config.apiKey',
      'config.token',
      'config.password',
      '*.password',
      '*.secret',
    ],
    censor: '[REDACTED]',
  },
};

export const logger = pino(
  isDevelopment
    ? {
        ...baseOptions,
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss.l',
            ignore: 'pid,hostname,service,env',
            singleLine: false,
          },
        },
      }
    : baseOptions,
);

export type Logger = PinoLogger;
