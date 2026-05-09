/**
 * Orchestrator entry point.
 *
 * Two responsibilities:
 *   1. Fire `runDailyScrape` once per cron interval (env.SCRAPE_CRON).
 *   2. Run the finalizer every 10 minutes — finds completed scrape_runs
 *      and writes their final stats + alerts.
 *
 * Both run in the same process; both are tiny so it's not worth splitting.
 *
 * Manual trigger: `node --env-file=.env dist/orchestrator/index.js --run-now`
 */

import cron from 'node-cron';
import { env } from '../shared/env.js';
import { logger } from '../shared/logger.js';
import { initSentry, captureError } from '../shared/sentry.js';
import { closeAllQueues } from '../shared/queue.js';
import { runDailyScrape } from './enqueue.js';
import { finalizePendingRuns } from './finalize.js';

initSentry('orchestrator');

const FINALIZER_INTERVAL_MS = 10 * 60 * 1000;

async function runScrapeWithErrorHandling(): Promise<void> {
  try {
    const result = await runDailyScrape();
    logger.info({ result }, 'daily scrape enqueued');
  } catch (err) {
    logger.error({ err }, 'daily scrape failed');
    captureError(err, { phase: 'daily-scrape' });
  }
}

async function runFinalizerWithErrorHandling(): Promise<void> {
  try {
    const finalized = await finalizePendingRuns();
    if (finalized > 0) {
      logger.info({ finalized }, 'finalizer pass: runs finalized');
    } else {
      logger.debug('finalizer pass: nothing to finalize');
    }
  } catch (err) {
    logger.error({ err }, 'finalizer failed');
    captureError(err, { phase: 'finalizer' });
  }
}

async function main(): Promise<void> {
  const runNow = process.argv.includes('--run-now');

  if (runNow) {
    // Manual one-shot mode — useful for testing on EC2 before the first
    // scheduled run, or for backfilling a missed day.
    logger.info('--run-now: triggering immediate daily scrape');
    await runScrapeWithErrorHandling();
    await runFinalizerWithErrorHandling();
    process.exit(0);
  }

  // Validate the cron expression before scheduling
  if (!cron.validate(env.SCRAPE_CRON)) {
    logger.fatal({ cron: env.SCRAPE_CRON }, 'invalid SCRAPE_CRON expression');
    process.exit(1);
  }

  logger.info(
    { cron: env.SCRAPE_CRON, tz: env.TZ },
    'orchestrator: scheduling daily scrape',
  );

  // 1. Daily scrape cron
  cron.schedule(env.SCRAPE_CRON, runScrapeWithErrorHandling, {
    timezone: env.TZ,
  });

  // 2. Finalizer interval — also run once at startup to catch any stuck runs
  // from a previous process that died mid-run.
  void runFinalizerWithErrorHandling();
  const finalizerHandle = setInterval(
    runFinalizerWithErrorHandling,
    FINALIZER_INTERVAL_MS,
  );

  // 3. Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'orchestrator shutting down');
    clearInterval(finalizerHandle);
    await closeAllQueues();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  logger.info('orchestrator running');
}

main().catch((err) => {
  logger.fatal({ err }, 'orchestrator bootstrap failed');
  captureError(err, { phase: 'bootstrap' });
  process.exit(1);
});
