/**
 * API server entry point.
 *
 * Builds the Express app and binds it to env.API_PORT. Handles graceful
 * shutdown so PM2 reload doesn't drop in-flight requests.
 */

import { env } from '../shared/env.js';
import { logger } from '../shared/logger.js';
import { initSentry, captureError } from '../shared/sentry.js';
import { buildApp } from './app.js';
import { registerWebhook } from '../telegram/bot.js';

initSentry('api');

const SHUTDOWN_GRACE_MS = 10_000;

function main(): void {
  const app = buildApp();

  const server = app.listen(env.API_PORT, () => {
    logger.info({ port: env.API_PORT }, 'API listening');

    // Register Telegram webhook after the server is ready to accept requests
    if (env.TELEGRAM_WEBHOOK_SECRET && env.API_BASE_URL) {
      const webhookUrl = `${env.API_BASE_URL}/telegram/callback`;
      void registerWebhook(webhookUrl);
    }
  });

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'API shutting down');
    server.close(() => process.exit(0));
    // Hard-kill if cleanup takes too long
    setTimeout(() => {
      logger.warn({ signal }, 'forcing exit after grace period');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

try {
  main();
} catch (err) {
  logger.fatal({ err }, 'API bootstrap failed');
  captureError(err, { phase: 'bootstrap' });
  process.exit(1);
}
