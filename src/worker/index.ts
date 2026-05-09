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

async function main(): Promise<void> {
  const supermarkets = await loadActiveSupermarkets();
  if (supermarkets.length === 0) {
    logger.warn('no active supermarkets in DB — worker will idle');
  } else {
    logger.info({ count: supermarkets.length }, 'starting workers');
  }

  const workers = supermarkets.map(createWorker);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down workers');
    await Promise.all(workers.map((w) => w.close()));
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
