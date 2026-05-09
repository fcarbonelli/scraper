/**
 * Sentry initialization.
 *
 * Call `initSentry()` ONCE at the very start of each process entry point
 * (worker, orchestrator, api). It's a no-op if SENTRY_DSN is not configured.
 */

import * as Sentry from '@sentry/node';
import { env, isProduction } from './env.js';
import { logger } from './logger.js';

let initialized = false;

export function initSentry(processName: 'worker' | 'orchestrator' | 'api'): void {
  if (initialized) return;
  initialized = true;

  if (!env.SENTRY_DSN) {
    logger.debug({ processName }, 'Sentry disabled (no DSN configured)');
    return;
  }

  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    // Lower sample rates in production to control cost
    tracesSampleRate: isProduction ? 0.05 : 1.0,
    // Tag every event with which process produced it
    initialScope: {
      tags: { process: processName },
    },
  });

  logger.info({ processName }, 'Sentry initialized');
}

/** Capture an exception with optional context. Safe to call when disabled. */
export function captureError(
  err: unknown,
  context?: Record<string, unknown>,
): void {
  if (!initialized || !env.SENTRY_DSN) return;
  Sentry.withScope((scope) => {
    if (context) scope.setContext('details', context);
    Sentry.captureException(err);
  });
}

export { Sentry };
