/**
 * Orchestrator entry point.
 *
 * Two responsibilities:
 *   1. Fire `runDailyScrape` once per cron interval (env.SCRAPE_CRON).
 *   2. Run the finalizer every minute — finds completed scrape_runs
 *      and writes their final stats + alerts.
 *
 * Both run in the same process; both are tiny so it's not worth splitting.
 *
 * Manual triggers:
 *   node --env-file=.env dist/orchestrator/index.js --run-now
 *   node --env-file=.env dist/orchestrator/index.js --run-now --supermarket=maxi-carrefour
 *
 * The `--supermarket=<id>` flag scopes the run to one supermarket only,
 * which is handy when iterating on a single adapter without enqueueing
 * every other site (and burning their rate-limit budgets).
 */

import cron from 'node-cron';
import { env } from '../shared/env.js';
import { logger } from '../shared/logger.js';
import { initSentry, captureError } from '../shared/sentry.js';
import { closeAllQueues, getDiscoveryQueue } from '../shared/queue.js';
import { runDailyScrape } from './enqueue.js';
import { finalizePendingRuns } from './finalize.js';
import { runRevistaCheck } from '../revistas/pipeline.js';

initSentry('orchestrator');

const FINALIZER_INTERVAL_MS = 60 * 1000;

/**
 * Enqueue the daily scrape and return the run id so the magazine check can
 * attach its approved snapshots to the same run (published together).
 */
async function runScrapeWithErrorHandling(
  supermarketId?: string,
): Promise<string | null> {
  try {
    const result = await runDailyScrape(
      supermarketId ? { supermarketId } : {},
    );
    logger.info({ result }, 'daily scrape enqueued');
    return result.scrapeRunId;
  } catch (err) {
    logger.error({ err }, 'daily scrape failed');
    captureError(err, { phase: 'daily-scrape' });
    return null;
  }
}

/**
 * Magazine (revista) check: detect new promo PDFs/flipbooks, read them with
 * vision AI, and build the human review queue. Cheap no-op on days nothing
 * changed. Isolated from the main scrape so a failure here never affects it.
 */
async function runRevistaCheckWithErrorHandling(
  scrapeRunId: string | null,
): Promise<void> {
  try {
    const summaries = await runRevistaCheck({ scrapeRunId });
    if (summaries.length > 0) logger.info({ summaries }, 'revista check complete');
  } catch (err) {
    logger.error({ err }, 'revista check failed');
    captureError(err, { phase: 'revista-check' });
  }
}

/**
 * Pull a `--supermarket=<id>` (or `--supermarket <id>`) flag out of argv.
 * Returns undefined when the flag is missing. Validation of the id itself
 * (does it exist in the DB?) is left to {@link runDailyScrape}, which
 * naturally yields 0 jobs and a warning if the id doesn't match.
 */
function parseSupermarketArg(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (a.startsWith('--supermarket=')) return a.slice('--supermarket='.length);
    if (a === '--supermarket' && argv[i + 1]) return argv[i + 1];
  }
  return undefined;
}

/**
 * Enqueue the weekly coverage sweep (one job on the `discovery` queue). The
 * discovery worker fans it out across every active + searchable chain,
 * re-searching only the MISSING EANs and Telegram-summarizing what it added.
 */
async function enqueueCoverageSweep(): Promise<void> {
  try {
    const job = await getDiscoveryQueue().add('discover', { scope: 'sweep' });
    logger.info({ jobId: job.id }, 'weekly coverage sweep enqueued');
  } catch (err) {
    logger.error({ err }, 'failed to enqueue coverage sweep');
    captureError(err, { phase: 'coverage-sweep' });
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
    // scheduled run, or for backfilling a missed day. Optionally scoped
    // to a single supermarket via --supermarket=<id>.
    const onlySupermarket = parseSupermarketArg(process.argv);
    logger.info(
      { onlySupermarket },
      onlySupermarket
        ? `--run-now: triggering scrape for supermarket="${onlySupermarket}" only`
        : '--run-now: triggering immediate daily scrape',
    );
    const runId = await runScrapeWithErrorHandling(onlySupermarket);
    await runRevistaCheckWithErrorHandling(runId);
    await runFinalizerWithErrorHandling();
    process.exit(0);
  }

  // Manual one-shot sweep (handy for testing the weekly job on demand).
  if (process.argv.includes('--sweep-now')) {
    logger.info('--sweep-now: enqueuing coverage sweep');
    await enqueueCoverageSweep();
    process.exit(0);
  }

  // Validate the cron expressions before scheduling
  if (!cron.validate(env.SCRAPE_CRON)) {
    logger.fatal({ cron: env.SCRAPE_CRON }, 'invalid SCRAPE_CRON expression');
    process.exit(1);
  }
  if (!cron.validate(env.SWEEP_CRON)) {
    logger.fatal({ cron: env.SWEEP_CRON }, 'invalid SWEEP_CRON expression');
    process.exit(1);
  }

  logger.info(
    { cron: env.SCRAPE_CRON, sweepCron: env.SWEEP_CRON, tz: env.TZ },
    'orchestrator: scheduling daily scrape + weekly sweep',
  );

  // 1. Daily scrape cron.
  // Wrapped in an arrow so node-cron doesn't accidentally pass its
  // TaskContext arg as our optional `supermarketId` (TS2345 in CI).
  // After enqueuing, kick off the magazine check in the background (it can take
  // minutes for a changed issue) attached to the same run — we don't block the
  // cron callback on it.
  cron.schedule(
    env.SCRAPE_CRON,
    () =>
      void runScrapeWithErrorHandling().then((runId) =>
        runRevistaCheckWithErrorHandling(runId),
      ),
    { timezone: env.TZ },
  );

  // 1b. Weekly coverage sweep cron.
  cron.schedule(env.SWEEP_CRON, () => void enqueueCoverageSweep(), {
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
