/**
 * BullMQ queue setup.
 *
 * One queue per supermarket — this is what lets us apply per-site rate limits
 * and concurrency without affecting other supermarkets. Workers are configured
 * per-queue with the rate-limit and concurrency from the supermarkets table.
 */

import { Queue, type ConnectionOptions, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from './env.js';

/**
 * Build a Redis connection.
 *
 * BullMQ requires `maxRetriesPerRequest: null` and `enableReadyCheck: false`
 * for the connection used by workers (otherwise long-blocking commands break).
 * We use the same options for queue producers to keep things simple.
 */
export function createRedisConnection(): Redis {
  return new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    // Show actual reconnects in logs instead of silently retrying forever
    retryStrategy(times: number): number {
      return Math.min(times * 500, 5000);
    },
  });
}

/** Job payload our worker receives. Keep this small — Redis stores it. */
export interface ScrapeJobData {
  /** UUID of the supermarket_products row */
  supermarketProductId: string;
  /** Supermarket id ("coto", "carrefour", ...) for routing to adapter */
  supermarketId: string;
  /** Their SKU / external id */
  externalId: string;
  /** Canonical URL (no scraping params) */
  externalUrl: string | null;
  /** Optional run id, set by orchestrator for daily runs */
  scrapeRunId: string | null;
  /**
   * Which attempt this is (1 = first try). Set when re-enqueueing a retry.
   * Owned by the engine; adapters should not read this.
   */
  attempt?: number;
}

export type ScrapeJobName = 'scrape';

/**
 * Naming convention: one queue per supermarket. This is intentional —
 * BullMQ rate-limits and concurrency are per-queue, so isolating per-site
 * gives us per-site control naturally.
 */
export function queueNameFor(supermarketId: string): string {
  return `scrape:${supermarketId}`;
}

/** Cache of Queue instances so we don't open new Redis connections per call. */
const queues = new Map<string, Queue<ScrapeJobData, unknown, ScrapeJobName>>();

/**
 * Get (or create) the Queue for a given supermarket.
 * Reuses one shared Redis connection across all queues.
 */
export function getQueue(
  supermarketId: string,
  connection?: ConnectionOptions,
): Queue<ScrapeJobData, unknown, ScrapeJobName> {
  const name = queueNameFor(supermarketId);
  const cached = queues.get(name);
  if (cached) return cached;

  const queue = new Queue<ScrapeJobData, unknown, ScrapeJobName>(name, {
    connection: connection ?? createRedisConnection(),
    defaultJobOptions: defaultJobOptions(),
  });
  queues.set(name, queue);
  return queue;
}

/**
 * Default options for every enqueued job.
 *
 * - `attempts: 1` — we handle retries ourselves at the engine level so we can
 *   apply different policies per error type (rate-limited vs selector-failed).
 *   BullMQ's built-in retry would treat all failures the same.
 * - `removeOnComplete` keeps Redis memory bounded — we already have full
 *   history in `price_snapshots` and `job_executions`.
 */
export function defaultJobOptions(): JobsOptions {
  return {
    attempts: 1,
    removeOnComplete: { age: 60 * 60 * 24, count: 1000 }, // 24h or 1000 jobs
    removeOnFail: { age: 60 * 60 * 24 * 7 }, // keep failures for 7 days
  };
}

/** Cleanly close all queue connections (used on graceful shutdown). */
export async function closeAllQueues(): Promise<void> {
  await Promise.all(Array.from(queues.values()).map((q) => q.close()));
  queues.clear();
}
