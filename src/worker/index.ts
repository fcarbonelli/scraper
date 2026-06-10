/**
 * Worker bootstrap.
 *
 * On startup:
 *   1. Loads all active supermarkets from the DB.
 *   2. Spawns one BullMQ Worker per supermarket — each with that supermarket's
 *      own concurrency and rate limit. Per-site isolation falls out for free.
 *   3. Hands every job to `processJob`, which is queue-agnostic.
 *   4. On retry verdicts, re-enqueues with a per-error-type delay.
 *
 * Graceful shutdown: SIGINT/SIGTERM closes all workers and queues cleanly.
 */

import { Worker, type Job, type WorkerOptions } from 'bullmq';
import { db } from '../shared/db.js';
import { logger } from '../shared/logger.js';
import { initSentry, captureError } from '../shared/sentry.js';
import {
  createRedisConnection,
  defaultJobOptions,
  getQueue,
  queueNameFor,
  type ScrapeJobData,
} from '../shared/queue.js';
import { processJob } from './processJob.js';

initSentry('worker');

interface SupermarketRow {
  id: string;
  name: string;
  rate_limit_ms: number;
  concurrency: number;
}

async function loadActiveSupermarkets(): Promise<SupermarketRow[]> {
  const { data, error } = await db
    .from('supermarkets')
    .select('id, name, rate_limit_ms, concurrency')
    .eq('is_active', true);
  if (error) throw error;
  return (data ?? []) as SupermarketRow[];
}

/**
 * Build the BullMQ worker for a single supermarket.
 *
 * - `concurrency`: max parallel jobs from this supermarket's queue
 * - `limiter`:     rate limit between jobs (per worker)
 *
 * Both come from the DB and can be tuned without redeploying.
 */
function createWorker(supermarket: SupermarketRow): Worker<ScrapeJobData> {
  const queueName = queueNameFor(supermarket.id);
  const log = logger.child({ supermarket: supermarket.id, queue: queueName });

  const opts: WorkerOptions = {
    connection: createRedisConnection(),
    concurrency: supermarket.concurrency,
    // BullMQ's limiter caps to N jobs per `duration` ms across this worker.
    // We set N=1 with duration=rateLimitMs to enforce a min gap between jobs.
    ...(supermarket.rate_limit_ms > 0
      ? { limiter: { max: 1, duration: supermarket.rate_limit_ms } }
      : {}),
  };

  const worker = new Worker<ScrapeJobData>(
    queueName,
    async (job: Job<ScrapeJobData>) => {
      const attempt = job.data.attempt ?? 1;
      const verdict = await processJob(job.data, { attempt });

      if (verdict.status === 'retry_scheduled' && verdict.retry) {
        // Re-enqueue the same job with incremented attempt number and the
        // per-error-type delay decided by retryPolicy. The original job is
        // considered "complete" from BullMQ's perspective so it doesn't
        // double-count failures.
        const queue = getQueue(supermarket.id);
        await queue.add(
          'scrape',
          { ...job.data, attempt: verdict.retry.nextAttempt },
          {
            ...defaultJobOptions(),
            delay: verdict.retry.delayMs,
          },
        );
      }
    },
    opts,
  );

  worker.on('ready', () => log.info('worker ready'));
  worker.on('error', (err) => {
    log.error({ err }, 'worker error');
    captureError(err, { supermarket: supermarket.id });
  });
  worker.on('failed', (job, err) => {
    // Adapter-thrown failures bubble up here. We've already recorded them in
    // job_executions; this hook is mostly for unexpected/uncaught errors.
    log.error(
      { err, jobId: job?.id, sku: job?.data.externalId },
      'job threw unhandled error',
    );
    captureError(err, {
      supermarket: supermarket.id,
      jobId: job?.id,
      sku: job?.data.externalId,
    });
  });

  return worker;
}

/**
 * How often the worker re-checks the DB for newly-activated (or deactivated)
 * supermarkets. This is what lets activating a chain (db:setup flips
 * `is_active`) take effect WITHOUT a worker restart / `pm2 reload`.
 */
const RELOAD_INTERVAL_MS = 60 * 1000;

/** Live map of supermarket id -> its running BullMQ Worker. */
const workers = new Map<string, Worker<ScrapeJobData>>();

/**
 * Reconcile the running workers against the current set of active supermarkets:
 *   - spin up a Worker for any newly-active supermarket,
 *   - gracefully close the Worker for any supermarket that went inactive.
 *
 * Safe to call repeatedly. A transient DB error just skips this pass and keeps
 * the current workers running (we never tear everything down on a read blip).
 */
async function reconcileWorkers(): Promise<void> {
  let active: SupermarketRow[];
  try {
    active = await loadActiveSupermarkets();
  } catch (err) {
    logger.error({ err }, 'failed to reload active supermarkets; keeping current workers');
    return;
  }

  const activeIds = new Set(active.map((s) => s.id));

  // Start workers for newly-active supermarkets.
  for (const sm of active) {
    if (workers.has(sm.id)) continue;
    workers.set(sm.id, createWorker(sm));
    logger.info({ supermarket: sm.id }, 'started worker for newly-active supermarket');
  }

  // Tear down workers for supermarkets that are no longer active. `close()` is
  // graceful — it waits for any in-flight job on that queue to finish.
  for (const [id, worker] of workers) {
    if (activeIds.has(id)) continue;
    workers.delete(id);
    void worker.close().then(
      () => logger.info({ supermarket: id }, 'closed worker for deactivated supermarket'),
      (err) => logger.error({ err, supermarket: id }, 'error closing deactivated worker'),
    );
  }
}

async function main(): Promise<void> {
  await reconcileWorkers();
  if (workers.size === 0) {
    logger.warn('no active supermarkets in DB — worker idle (will keep polling)');
  } else {
    logger.info({ count: workers.size }, 'workers started');
  }

  // Poll for supermarkets activated/deactivated after startup so adding a chain
  // doesn't require restarting this process.
  const reloadHandle = setInterval(() => void reconcileWorkers(), RELOAD_INTERVAL_MS);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down workers');
    clearInterval(reloadHandle);
    await Promise.all(Array.from(workers.values()).map((w) => w.close()));
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'worker bootstrap failed');
  captureError(err, { phase: 'bootstrap' });
  process.exit(1);
});
