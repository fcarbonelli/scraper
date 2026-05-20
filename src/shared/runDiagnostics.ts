/**
 * Run diagnostics and progress helpers.
 *
 * These helpers intentionally aggregate in TypeScript instead of complex SQL:
 * daily runs are small enough, and keeping the logic here makes the API,
 * finalizer, and alerts agree on what "done" means.
 */

import { db } from './db.js';

export type JobExecutionStatus = 'success' | 'failed' | 'retrying';

export interface RunRow {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  total_jobs: number;
  succeeded: number;
  failed: number;
  retried: number;
  metadata: Record<string, unknown>;
}

export interface JobExecutionRow {
  id: string;
  scrape_run_id: string | null;
  supermarket_product_id: string;
  attempt: number;
  status: JobExecutionStatus;
  error_type: string | null;
  error_message: string | null;
  error_stack: string | null;
  tier_used: string | null;
  duration_ms: number | null;
  started_at: string;
  finished_at: string | null;
}

export interface SupermarketProductDebugRow {
  id: string;
  supermarket_id: string;
  external_id: string;
  external_url: string | null;
  product_id: string;
  products?: {
    id: string;
    name: string;
    brand: string | null;
    category: string | null;
    metadata: Record<string, unknown>;
  } | Array<{
    id: string;
    name: string;
    brand: string | null;
    category: string | null;
    metadata: Record<string, unknown>;
  }> | null;
  supermarkets?: {
    id: string;
    name: string;
  } | Array<{
    id: string;
    name: string;
  }> | null;
}

export interface FinalJobOutcome extends JobExecutionRow {
  attempts: number;
}

export interface SupermarketProgress {
  total: number;
  pending: number;
  running_or_retrying: number;
  succeeded: number;
  failed: number;
}

export interface RunProgress {
  total_jobs: number;
  distinct_started: number;
  completed: number;
  pending: number;
  succeeded: number;
  failed: number;
  running_or_retrying: number;
  retried_products: number;
  latest_activity_at: string | null;
  ms_since_latest_activity: number | null;
  by_supermarket: Record<string, SupermarketProgress>;
}

export interface RunDiagnostics {
  run: RunRow;
  executions: JobExecutionRow[];
  finalOutcomes: FinalJobOutcome[];
  progress: RunProgress;
}

export function latestOutcomeByProduct(rows: JobExecutionRow[]): Map<string, FinalJobOutcome> {
  const byProduct = new Map<string, FinalJobOutcome>();
  const attemptsByProduct = new Map<string, number>();

  for (const row of rows) {
    attemptsByProduct.set(
      row.supermarket_product_id,
      Math.max(attemptsByProduct.get(row.supermarket_product_id) ?? 0, row.attempt),
    );

    const current = byProduct.get(row.supermarket_product_id);
    if (!current || isNewerAttempt(row, current)) {
      byProduct.set(row.supermarket_product_id, { ...row, attempts: row.attempt });
    }
  }

  for (const [productId, outcome] of byProduct) {
    outcome.attempts = attemptsByProduct.get(productId) ?? outcome.attempt;
  }

  return byProduct;
}

function isNewerAttempt(candidate: JobExecutionRow, current: JobExecutionRow): boolean {
  if (candidate.attempt !== current.attempt) return candidate.attempt > current.attempt;
  return new Date(candidate.started_at).getTime() > new Date(current.started_at).getTime();
}

export async function loadRunDiagnostics(scrapeRunId: string): Promise<RunDiagnostics | null> {
  const runRes = await db
    .from('scrape_runs')
    .select(
      'id, started_at, finished_at, status, total_jobs, succeeded, failed, retried, metadata',
    )
    .eq('id', scrapeRunId)
    .maybeSingle();
  if (runRes.error) throw runRes.error;
  if (!runRes.data) return null;

  const jobsRes = await db
    .from('job_executions')
    .select(
      'id, scrape_run_id, supermarket_product_id, attempt, status, error_type, error_message, error_stack, tier_used, duration_ms, started_at, finished_at',
    )
    .eq('scrape_run_id', scrapeRunId);
  if (jobsRes.error) throw jobsRes.error;

  const run = runRes.data as RunRow;
  const executions = (jobsRes.data ?? []) as JobExecutionRow[];
  const finalOutcomes = Array.from(latestOutcomeByProduct(executions).values());
  const progress = await buildRunProgress(run, finalOutcomes, executions);

  return { run, executions, finalOutcomes, progress };
}

export async function buildRunProgress(
  run: RunRow,
  finalOutcomes: FinalJobOutcome[],
  executions: JobExecutionRow[],
): Promise<RunProgress> {
  const latestActivityAt = latestActivity(executions);
  const bySupermarket = await buildSupermarketProgress(run, finalOutcomes);
  const succeeded = finalOutcomes.filter((j) => j.status === 'success').length;
  const failed = finalOutcomes.filter((j) => j.status === 'failed').length;
  const runningOrRetrying = finalOutcomes.filter((j) => j.status === 'retrying').length;
  const distinctStarted = finalOutcomes.length;
  const totalJobs = run.total_jobs;

  return {
    total_jobs: totalJobs,
    distinct_started: distinctStarted,
    completed: succeeded + failed,
    pending: Math.max(totalJobs - distinctStarted, 0),
    succeeded,
    failed,
    running_or_retrying: runningOrRetrying,
    retried_products: finalOutcomes.filter((j) => j.attempts > 1).length,
    latest_activity_at: latestActivityAt,
    ms_since_latest_activity: latestActivityAt
      ? Date.now() - new Date(latestActivityAt).getTime()
      : null,
    by_supermarket: bySupermarket,
  };
}

function latestActivity(executions: JobExecutionRow[]): string | null {
  let latest: string | null = null;
  let latestMs = 0;
  for (const row of executions) {
    const timestamp = row.finished_at ?? row.started_at;
    const ms = new Date(timestamp).getTime();
    if (ms > latestMs) {
      latestMs = ms;
      latest = timestamp;
    }
  }
  return latest;
}

async function buildSupermarketProgress(
  run: RunRow,
  finalOutcomes: FinalJobOutcome[],
): Promise<Record<string, SupermarketProgress>> {
  const planned = plannedBySupermarket(run.metadata);
  const out: Record<string, SupermarketProgress> = {};

  for (const [supermarketId, total] of Object.entries(planned)) {
    out[supermarketId] = {
      total,
      pending: total,
      running_or_retrying: 0,
      succeeded: 0,
      failed: 0,
    };
  }

  const mappingIds = Array.from(new Set(finalOutcomes.map((j) => j.supermarket_product_id)));
  const mappingToSupermarket = await loadMappingSupermarkets(mappingIds);

  for (const job of finalOutcomes) {
    const supermarketId = mappingToSupermarket.get(job.supermarket_product_id) ?? 'unknown';
    const bucket =
      out[supermarketId] ??
      (out[supermarketId] = {
        total: 0,
        pending: 0,
        running_or_retrying: 0,
        succeeded: 0,
        failed: 0,
      });

    if (!(supermarketId in planned)) bucket.total += 1;
    if (job.status === 'success') bucket.succeeded += 1;
    else if (job.status === 'failed') bucket.failed += 1;
    else bucket.running_or_retrying += 1;
  }

  for (const bucket of Object.values(out)) {
    bucket.pending = Math.max(
      bucket.total - bucket.succeeded - bucket.failed - bucket.running_or_retrying,
      0,
    );
  }

  return out;
}

function plannedBySupermarket(metadata: Record<string, unknown>): Record<string, number> {
  const raw = metadata.by_supermarket ?? metadata.bySupermarket;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};

  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'number' && Number.isFinite(value)) result[key] = value;
  }
  return result;
}

async function loadMappingSupermarkets(mappingIds: string[]): Promise<Map<string, string>> {
  if (mappingIds.length === 0) return new Map();

  const { data, error } = await db
    .from('supermarket_products')
    .select('id, supermarket_id')
    .in('id', mappingIds);
  if (error) throw error;

  return new Map((data ?? []).map((m) => [m.id as string, m.supermarket_id as string]));
}

