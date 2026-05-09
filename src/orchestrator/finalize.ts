/**
 * Run finalizer.
 *
 * Periodically scans scrape_runs that are still 'running'. For each one:
 *   1. Decide whether the run is "done": no jobs in 'retrying' state and the
 *      latest activity is older than QUIESCENCE_MS.
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

/**
 * How long after the most recent job activity to wait before considering
 * a run "done". Should be longer than the longest retry delay (30 min for
 * rate_limited). 90 minutes gives a comfortable margin.
 */
const QUIESCENCE_MS = 90 * 60 * 1000;

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

interface JobStatusCounts {
  total: number;
  succeeded: number;
  failed: number;
  retrying: number;
  /** ms since the latest started_at across job_executions in this run. */
  msSinceLatestActivity: number | null;
}

async function loadRunningRuns(): Promise<RunningRun[]> {
  const { data, error } = await db
    .from('scrape_runs')
    .select('id, started_at, total_jobs')
    .eq('status', 'running');
  if (error) throw error;
  return (data ?? []) as RunningRun[];
}

async function countByStatus(scrapeRunId: string): Promise<JobStatusCounts> {
  // Pull only the columns we need. With ~3000 rows this is cheap.
  const { data, error } = await db
    .from('job_executions')
    .select('status, started_at')
    .eq('scrape_run_id', scrapeRunId);
  if (error) throw error;

  let succeeded = 0;
  let failed = 0;
  let retrying = 0;
  let latestActivity = 0;

  for (const row of data ?? []) {
    const t = new Date(row.started_at).getTime();
    if (t > latestActivity) latestActivity = t;
    switch (row.status) {
      case 'success':
        succeeded += 1;
        break;
      case 'failed':
        failed += 1;
        break;
      case 'retrying':
        retrying += 1;
        break;
    }
  }

  return {
    total: (data ?? []).length,
    succeeded,
    failed,
    retrying,
    msSinceLatestActivity: latestActivity > 0 ? Date.now() - latestActivity : null,
  };
}

/**
 * Decide whether a run can be finalized. A run is "done" when:
 *   - it has no jobs in 'retrying' status, AND
 *   - the latest job_execution started over QUIESCENCE_MS ago
 *     (so we don't race with a worker that's about to write a row), OR
 *   - the run is older than MAX_RUN_AGE_MS (force finalize)
 */
function isDone(
  run: RunningRun,
  counts: JobStatusCounts,
  nowMs: number,
): boolean {
  const ageMs = nowMs - new Date(run.started_at).getTime();
  if (ageMs >= MAX_RUN_AGE_MS) return true;

  if (counts.retrying > 0) return false;
  if (counts.total === 0) {
    // No job_executions yet — the orchestrator might still be enqueueing.
    // Only finalize if the run has been around for a while.
    return ageMs >= QUIESCENCE_MS;
  }

  if (counts.msSinceLatestActivity === null) return false;
  return counts.msSinceLatestActivity >= QUIESCENCE_MS;
}

/** Mark the run completed and trigger alerts. Idempotent against re-runs. */
async function finalizeRun(
  run: RunningRun,
  counts: JobStatusCounts,
): Promise<void> {
  const log = logger.child({ runId: run.id });

  // 1. Update scrape_runs row
  const { error: updateErr } = await db
    .from('scrape_runs')
    .update({
      status: 'completed',
      finished_at: new Date().toISOString(),
      succeeded: counts.succeeded,
      failed: counts.failed,
      retried: 0, // total retries — left as 0 in v1 (low signal)
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
      total: counts.total,
      succeeded: counts.succeeded,
      failed: counts.failed,
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
    const counts = await countByStatus(run.id);
    if (!isDone(run, counts, now)) continue;
    try {
      await finalizeRun(run, counts);
      finalized += 1;
    } catch (err) {
      logger.error({ err, runId: run.id }, 'failed to finalize run');
    }
  }
  return finalized;
}
