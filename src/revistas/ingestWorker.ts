/**
 * Revista ingest worker — the engine behind the panel's "Traer" button.
 *
 * Consumes the single `revista-ingest` queue (see src/shared/queue.ts). Each job
 * re-discovers one chain, ingests the flyers it was asked for, reports progress
 * via `job.updateProgress()`, and returns the per-flyer outcomes as the job's
 * return value. `GET /v1/revistas/ingest/:jobId` reads both back off the job —
 * no state table, exactly like the discovery worker it's modelled on.
 *
 * WHERE THIS RUNS MATTERS. It is started by the ORCHESTRATOR, not the worker
 * process and never the API:
 *
 *   - `api` is capped at 300M (ecosystem.config.cjs). That is the same ceiling
 *     that silently SIGKILLed the orchestrator every day from 28/07 to 03/08
 *     while it rendered a Makro PDF — 138 restarts, no error, no row. Rendering
 *     inside the API would take the whole API down with it, and an ingest is
 *     minutes long anyway.
 *   - `worker` has 900M but runs Playwright scrapes concurrently.
 *   - `orchestrator` has 1G, was raised to it for exactly this workload, and has
 *     no Playwright competing for the same heap.
 *
 * `concurrency: 1` keeps two ingests from rendering at once. It does NOT
 * serialise against the 6am check running in the same process: a click landing
 * mid-render is a narrow, recoverable window (PM2 restarts, and the guard inside
 * the job makes the retry a skip).
 */

import { Worker, type Job, type WorkerOptions } from 'bullmq';
import { logger } from '../shared/logger.js';
import { captureError } from '../shared/sentry.js';
import {
  createRedisConnection,
  REVISTA_INGEST_QUEUE_NAME,
  type RevistaIngestJobData,
} from '../shared/queue.js';
import { ingestCandidatesByHash, type IngestOutcome } from './pipeline.js';

async function runJob(job: Job<RevistaIngestJobData>): Promise<IngestOutcome[]> {
  const { supermarketId, candidates, force } = job.data;
  const log = logger.child({ ingestJobId: job.id, supermarket: supermarketId });
  log.info({ requested: candidates?.length ?? 0, force: Boolean(force) }, 'revista ingest job start');

  const outcomes = await ingestCandidatesByHash(supermarketId, {
    ...(candidates ? { candidates } : {}),
    ...(force === undefined ? {} : { force }),
    // Fire-and-forget: a Redis write must never pace the pipeline, and a failed
    // progress update must never fail the ingest.
    onProgress: (p) => void job.updateProgress(p).catch(() => {}),
  });

  log.info({ outcomes: outcomes.length }, 'revista ingest job done');
  return outcomes;
}

/** Build and start the revista ingest worker. */
export function createRevistaIngestWorker(): Worker<RevistaIngestJobData, IngestOutcome[]> {
  const opts: WorkerOptions = {
    connection: createRedisConnection(),
    concurrency: 1,
  };

  const worker = new Worker<RevistaIngestJobData, IngestOutcome[]>(
    REVISTA_INGEST_QUEUE_NAME,
    (job) => runJob(job),
    opts,
  );

  worker.on('ready', () => logger.info('revista ingest worker ready'));
  worker.on('error', (err) => {
    logger.error({ err }, 'revista ingest worker error');
    captureError(err, { worker: 'revista-ingest' });
  });
  worker.on('failed', (job, err) => {
    logger.error({ err, jobId: job?.id }, 'revista ingest job failed');
    captureError(err, { worker: 'revista-ingest', jobId: job?.id });
  });

  return worker;
}
