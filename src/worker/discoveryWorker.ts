/**
 * Discovery worker.
 *
 * Consumes the single `discovery` queue (see src/shared/queue.ts). Each job
 * expands its scope into a list of (ean, supermarket) targets, runs the
 * discovery core against each, reports progress via `job.updateProgress()`,
 * and returns the full per-target results array as the job's return value.
 *
 * The API's GET /v1/data/discover/:jobId reads both progress and return value
 * back off the BullMQ job — no separate state table needed.
 */

import { Worker, type Job, type WorkerOptions } from 'bullmq';
import { logger } from '../shared/logger.js';
import { captureError } from '../shared/sentry.js';
import {
  createRedisConnection,
  DISCOVERY_QUEUE_NAME,
  type DiscoveryJobData,
} from '../shared/queue.js';
import { getCatalogEans } from '../shared/catalog.js';
import {
  discoverEanAtSupermarket,
  discoverEanEverywhere,
  discoverAllEansAtSupermarket,
  adaptersWithSearch,
  type DiscoverOutcome,
} from '../discovery/index.js';

/** Running tallies mirrored into job progress so the UI can show a bar. */
export interface DiscoveryProgress {
  total: number;
  done: number;
  found: number;
  ingested: number;
  notFound: number;
  errors: number;
}

function emptyProgress(total: number): DiscoveryProgress {
  return { total, done: 0, found: 0, ingested: 0, notFound: 0, errors: 0 };
}

function tally(progress: DiscoveryProgress, o: DiscoverOutcome): void {
  progress.done += 1;
  if (o.result === 'ingested') {
    progress.found += 1;
    progress.ingested += 1;
  } else if (o.result === 'existed') {
    progress.found += 1;
  } else if (o.result === 'not_found' || o.result === 'no_search') {
    progress.notFound += 1;
  } else if (o.result === 'error') {
    progress.errors += 1;
  }
}

async function runJob(job: Job<DiscoveryJobData>): Promise<DiscoverOutcome[]> {
  const data = job.data;
  const log = logger.child({ discoveryJobId: job.id, scope: data.scope });

  // A single EAN at a single chain — trivial, no fan-out.
  if (data.scope === 'ean_at_supermarket') {
    const progress = emptyProgress(1);
    await job.updateProgress(progress);
    const outcome = await discoverEanAtSupermarket(data.ean, data.supermarketId);
    tally(progress, outcome);
    await job.updateProgress(progress);
    log.info({ progress }, 'discovery job complete');
    return [outcome];
  }

  // Fan-out scopes share a progress callback. We size `total` up front so the
  // UI can render a determinate bar; the discovery core streams outcomes back.
  let progress: DiscoveryProgress | null = null;
  const onProgress = async (o: DiscoverOutcome): Promise<void> => {
    if (progress) {
      tally(progress, o);
      await job.updateProgress(progress);
    }
  };

  // Wrap the sync onProgress the core expects — we fire-and-forget the async
  // progress write so we don't block the discovery loop on Redis.
  const cb = (o: DiscoverOutcome): void => void onProgress(o);

  if (data.scope === 'ean') {
    progress = emptyProgress(adaptersWithSearch().length);
    await job.updateProgress(progress);
    const outcomes = await discoverEanEverywhere(data.ean, 1500, cb);
    log.info({ progress }, 'discovery job complete');
    return outcomes;
  }

  // scope === 'supermarket'
  const catalogSize = (await getCatalogEans()).size;
  progress = emptyProgress(catalogSize);
  await job.updateProgress(progress);
  const outcomes = await discoverAllEansAtSupermarket(data.supermarketId, 1500, cb);
  log.info({ progress }, 'discovery job complete');
  return outcomes;
}

/** Build and start the discovery worker. */
export function createDiscoveryWorker(): Worker<DiscoveryJobData, DiscoverOutcome[]> {
  const opts: WorkerOptions = {
    connection: createRedisConnection(),
    // Discovery jobs are long-running fan-outs; one at a time is plenty and
    // keeps us polite across all sites.
    concurrency: 1,
  };

  const worker = new Worker<DiscoveryJobData, DiscoverOutcome[]>(
    DISCOVERY_QUEUE_NAME,
    (job) => runJob(job),
    opts,
  );

  worker.on('ready', () => logger.info('discovery worker ready'));
  worker.on('error', (err) => {
    logger.error({ err }, 'discovery worker error');
    captureError(err, { worker: 'discovery' });
  });
  worker.on('failed', (job, err) => {
    logger.error({ err, jobId: job?.id }, 'discovery job failed');
    captureError(err, { worker: 'discovery', jobId: job?.id });
  });

  return worker;
}
