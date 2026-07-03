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
import { db } from '../shared/db.js';
import { notifyAlert } from '../alerts/notify.js';
import {
  discoverEanAtSupermarket,
  discoverEanEverywhere,
  discoverAllEansAtSupermarket,
  missingEansForSupermarket,
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

  // Weekly coverage sweep — re-search missing EANs across every searchable chain.
  if (data.scope === 'sweep') {
    return runSweep(job);
  }

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

/**
 * Weekly coverage sweep: for every active + searchable supermarket, re-search
 * the catalog EANs that aren't mapped there yet (products that were out of
 * stock / absent last time may have returned). Auto-ingests any found, then
 * sends a Telegram summary of what was added.
 */
async function runSweep(job: Job<DiscoveryJobData>): Promise<DiscoverOutcome[]> {
  const log = logger.child({ discoveryJobId: job.id, scope: 'sweep' });

  // Active supermarkets (DB) that also have EAN search (adapter).
  const { data: activeRows, error } = await db
    .from('supermarkets')
    .select('id')
    .eq('is_active', true);
  if (error) throw error;
  const searchable = new Set(adaptersWithSearch());
  const chains = (activeRows ?? [])
    .map((r) => r.id as string)
    .filter((id) => searchable.has(id));

  // Plan up front so progress has an exact denominator and we don't double-query.
  const plan: Array<{ id: string; missing: string[] }> = [];
  for (const id of chains) {
    plan.push({ id, missing: await missingEansForSupermarket(id) });
  }
  const total = plan.reduce((n, p) => n + p.missing.length, 0);
  const progress = emptyProgress(total);
  await job.updateProgress(progress);
  log.info({ chains: chains.length, total }, 'coverage sweep starting');

  const outcomes: DiscoverOutcome[] = [];
  const addedByChain: Record<string, number> = {};
  for (const { id, missing } of plan) {
    for (const ean of missing) {
      const outcome = await discoverEanAtSupermarket(ean, id);
      outcomes.push(outcome);
      tally(progress, outcome);
      await job.updateProgress(progress);
      if (outcome.result === 'ingested') {
        addedByChain[id] = (addedByChain[id] ?? 0) + 1;
      }
      // Be polite: short pause on misses, longer after a hit.
      await sleep(outcome.result === 'not_found' ? 300 : 1500);
    }
  }

  await sendSweepSummary(progress, addedByChain);
  log.info({ progress, addedByChain }, 'coverage sweep complete');
  return outcomes;
}

/** Telegram summary of a sweep — only the "new products added" story. */
async function sendSweepSummary(
  progress: DiscoveryProgress,
  addedByChain: Record<string, number>,
): Promise<void> {
  const chainsWithAdds = Object.keys(addedByChain).length;
  const lines = Object.entries(addedByChain)
    .sort((a, b) => b[1] - a[1])
    .map(([id, n]) => `• ${id}: +${n}`);

  await notifyAlert({
    severity: 'info',
    title:
      progress.ingested > 0
        ? `Weekly sweep: added ${progress.ingested} product(s) across ${chainsWithAdds} chain(s)`
        : 'Weekly sweep: no new products found',
    body: lines.length > 0 ? lines.join('\n') : undefined,
    context: {
      searched: progress.total,
      found: progress.found,
      ingested: progress.ingested,
      errors: progress.errors,
    },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
