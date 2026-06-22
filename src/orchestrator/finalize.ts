/**
 * Run finalizer.
 *
 * Periodically scans scrape_runs that are still 'running'. For each one:
 *   1. Decide whether the run is "done": every planned product has a final
 *      latest outcome (success or failed), and no product's latest outcome is
 *      still retrying.
 *   2. Compute final stats from job_executions and write them to scrape_runs.
 *   3. Run alert aggregation (creates supermarket-level alerts as needed).
 *   4. Update each supermarket's `health_status`.
 *
 * Why poll instead of triggering off the worker? Two reasons:
 *   - Workers don't reliably know which job is "the last one" (jobs span
 *     multiple queues, retries are scheduled into the future, etc.).
 *   - The orchestrator owning finalization keeps the worker simpler.
 */

import { db } from '../shared/db.js';
import { logger } from '../shared/logger.js';
import { generateAlertsForRun, updateSupermarketHealth } from '../alerts/aggregate.js';
import { loadRunDiagnostics, type RunProgress } from '../shared/runDiagnostics.js';

/**
 * Short guard for brand-new runs whose total_jobs has not been stamped yet.
 * Once total_jobs is available, finalization is based on latest product
 * outcomes rather than a long "quiet period".
 */
const ENQUEUE_GRACE_MS = 5 * 60 * 1000;

/**
 * Hard ceiling: finalize after this many hours regardless of activity, so a
 * pathological run doesn't sit "running" forever.
 */
const MAX_RUN_AGE_MS = 6 * 60 * 60 * 1000;

interface RunningRun {
  id: string;
  started_at: string;
  total_jobs: number;
}

async function loadRunningRuns(): Promise<RunningRun[]> {
  const { data, error } = await db
    .from('scrape_runs')
    .select('id, started_at, total_jobs')
    .eq('status', 'running');
  if (error) throw error;
  return (data ?? []) as RunningRun[];
}

/**
 * Decide whether a run can be finalized. A run is "done" when:
 *   - every planned product has started at least once,
 *   - no latest product outcome is still 'retrying',
 *   - every latest product outcome is either success or final failed, OR
 *   - the run is older than MAX_RUN_AGE_MS (force finalize)
 */
function isDone(
  run: RunningRun,
  progress: RunProgress,
  nowMs: number,
): boolean {
  const ageMs = nowMs - new Date(run.started_at).getTime();
  if (ageMs >= MAX_RUN_AGE_MS) return true;

  if (run.total_jobs === 0) return ageMs >= ENQUEUE_GRACE_MS;
  if (progress.pending > 0) return false;
  if (progress.running_or_retrying > 0) return false;
  return progress.completed >= run.total_jobs;
}

/** Mark the run completed and trigger alerts. Idempotent against re-runs. */
async function finalizeRun(
  run: RunningRun,
  progress: RunProgress,
): Promise<void> {
  const log = logger.child({ runId: run.id });

  // 1. Update scrape_runs row.
  //    `review_status` stays at its 'pending_review' default — the run is now
  //    finished but NOT yet visible to the client. An operator publishes it via
  //    POST /v1/runs/:id/publish (see src/orchestrator/publish.ts). We set it
  //    explicitly here so intent is clear and pre-default rows are covered.
  const { error: updateErr } = await db
    .from('scrape_runs')
    .update({
      status: 'completed',
      review_status: 'pending_review',
      finished_at: new Date().toISOString(),
      succeeded: progress.succeeded,
      failed: progress.failed,
      retried: progress.retried_products,
      // total_jobs was set by the orchestrator at enqueue time
    })
    .eq('id', run.id)
    .eq('status', 'running'); // guard against double-finalize
  if (updateErr) throw updateErr;

  // 2. Generate aggregated alerts (1 per supermarket, max)
  try {
    const result = await generateAlertsForRun(run.id);
    log.info({ alertsCreated: result.alertsCreated }, 'generated run alerts');
  } catch (err) {
    log.error({ err }, 'alert generation failed (run still finalized)');
  }

  // 3. Update supermarket health flags
  try {
    await updateSupermarketHealth(run.id);
  } catch (err) {
    log.error({ err }, 'health update failed (run still finalized)');
  }

  log.info(
    {
      total: progress.total_jobs,
      succeeded: progress.succeeded,
      failed: progress.failed,
      retried: progress.retried_products,
    },
    'run finalized',
  );
}

/**
 * One pass of the finalizer. Call from a setInterval, or on demand.
 * Returns how many runs were finalized this pass.
 */
export async function finalizePendingRuns(): Promise<number> {
  const runs = await loadRunningRuns();
  if (runs.length === 0) return 0;

  const now = Date.now();
  let finalized = 0;
  for (const run of runs) {
    const diagnostics = await loadRunDiagnostics(run.id);
    if (!diagnostics) continue;
    const progress = diagnostics.progress;
    if (!isDone(run, progress, now)) continue;
    try {
      await finalizeRun(run, progress);
      finalized += 1;
    } catch (err) {
      logger.error({ err, runId: run.id }, 'failed to finalize run');
    }
  }
  return finalized;
}
