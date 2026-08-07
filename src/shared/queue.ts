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
 * Discovery job payload. One of three scopes (see docs/PRODUCT_MANAGEMENT.md):
 *   - ean:                search this EAN at every chain with searchByEan
 *   - supermarket:        search all catalog EANs at one chain
 *   - ean_at_supermarket: one EAN at one chain
 */
export type DiscoveryJobData =
  | { scope: 'ean'; ean: string }
  | { scope: 'supermarket'; supermarketId: string }
  | { scope: 'ean_at_supermarket'; ean: string; supermarketId: string }
  /** Weekly coverage sweep: re-search MISSING EANs at every searchable chain. */
  | { scope: 'sweep' };

export type DiscoveryJobName = 'discover';

/** Single shared queue for discovery jobs (not per-supermarket). */
export const DISCOVERY_QUEUE_NAME = 'discovery';

/**
 * Revista ingest payload: bring one or more flyers the check button listed.
 *
 * Candidates travel as HASHES, never URLs. The job re-runs discovery against
 * the chain's own site and only ingests what it finds there, so a caller can't
 * turn this into "download and vision-scan this arbitrary PDF" — which is what
 * accepting a URL from the panel would mean.
 */
export interface RevistaIngestJobData {
  supermarketId: string;
  /**
   * Candidates from POST /v1/revistas/check. Empty = every ingestable one.
   * `sourceUrl` is the fallback key: an html-pdf-links hash folds in
   * content-length/ETag, and Vital re-uploads the same file several times a
   * day, so the hash the operator saw can be stale minutes later while the URL
   * still names the same flyer.
   */
  candidates?: { hash: string; sourceUrl?: string }[];
  /** Rescan even if the guard says it's already stored / a re-upload. */
  force?: boolean;
}

export type RevistaIngestJobName = 'ingest';

/** Single shared queue for manual revista ingests (not per-supermarket). */
export const REVISTA_INGEST_QUEUE_NAME = 'revista-ingest';

/**
 * Naming convention: one queue per supermarket. This is intentional —
 * BullMQ rate-limits and concurrency are per-queue, so isolating per-site
 * gives us per-site control naturally.
 *
 * Separator is `-` (not `:`) because BullMQ v5+ rejects queue names
 * containing `:` — it reserves the colon for internal Redis key namespacing.
 */
export function queueNameFor(supermarketId: string): string {
  return `scrape-${supermarketId}`;
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

/**
 * Discovery queue singleton. Unlike scrape queues (one per supermarket), there
 * is a single discovery queue — jobs fan out to many chains internally and are
 * rate-limited inside the processor, not by BullMQ.
 */
let discoveryQueue: Queue<DiscoveryJobData, unknown, DiscoveryJobName> | null = null;

export function getDiscoveryQueue(
  connection?: ConnectionOptions,
): Queue<DiscoveryJobData, unknown, DiscoveryJobName> {
  if (discoveryQueue) return discoveryQueue;
  discoveryQueue = new Queue<DiscoveryJobData, unknown, DiscoveryJobName>(DISCOVERY_QUEUE_NAME, {
    connection: connection ?? createRedisConnection(),
    defaultJobOptions: {
      // Discovery is idempotent and observable via the results — keep a
      // window of finished jobs so the status endpoint can read them.
      removeOnComplete: { age: 60 * 60 * 24, count: 500 },
      removeOnFail: { age: 60 * 60 * 24 * 7 },
    },
  });
  return discoveryQueue;
}

/**
 * Revista ingest queue singleton. One shared queue, worker concurrency 1: an
 * ingest renders a PDF and runs vision over every page, so two at once in the
 * same process is how the orchestrator got OOM-killed for a week in July.
 */
let revistaIngestQueue: Queue<RevistaIngestJobData, unknown, RevistaIngestJobName> | null = null;

export function getRevistaIngestQueue(
  connection?: ConnectionOptions,
): Queue<RevistaIngestJobData, unknown, RevistaIngestJobName> {
  if (revistaIngestQueue) return revistaIngestQueue;
  revistaIngestQueue = new Queue<RevistaIngestJobData, unknown, RevistaIngestJobName>(
    REVISTA_INGEST_QUEUE_NAME,
    {
      connection: connection ?? createRedisConnection(),
      defaultJobOptions: {
        // Same reason as discovery: the status endpoint reads finished jobs
        // back off the queue, so keep a window of them instead of a state table.
        removeOnComplete: { age: 60 * 60 * 24, count: 500 },
        removeOnFail: { age: 60 * 60 * 24 * 7 },
      },
    },
  );
  return revistaIngestQueue;
}

/** Cleanly close all queue connections (used on graceful shutdown). */
export async function closeAllQueues(): Promise<void> {
  await Promise.all(Array.from(queues.values()).map((q) => q.close()));
  queues.clear();
  if (discoveryQueue) {
    await discoveryQueue.close();
    discoveryQueue = null;
  }
  if (revistaIngestQueue) {
    await revistaIngestQueue.close();
    revistaIngestQueue = null;
  }
}
