/**
 * Durable discovery-job rows.
 *
 * BullMQ drops completed jobs (the queue is a work list, not an archive).
 * The dashboard lists sweeps for weeks after Sunday, so each job is also
 * written to `discovery_jobs`. A missing table must not fail a scrape or a
 * sweep — persistence logs and continues; Redis still runs the job.
 */

import type { Job } from 'bullmq';
import { db } from '../shared/db.js';
import { logger } from '../shared/logger.js';
import { getDiscoveryQueue, type DiscoveryJobData } from '../shared/queue.js';
import type { DiscoverOutcome } from './index.js';
import type { ChainSweepStat } from './weeklyReport.js';

const log = logger.child({ module: 'discovery-jobs' });

export interface DiscoveryJobRecord {
  id: string;
  scope: string;
  status: string;
  ean: string | null;
  supermarket_id: string | null;
  progress: Record<string, number>;
  chain_summary: ChainSweepStat[] | null;
  created_at: string;
  finished_at: string | null;
  failed_reason: string | null;
}

export interface DiscoveryJobPatch {
  scope?: string;
  status?: string;
  ean?: string | null;
  supermarketId?: string | null;
  progress?: Record<string, number>;
  chainSummary?: ChainSweepStat[] | null;
  createdAt?: string;
  finishedAt?: string | null;
  failedReason?: string | null;
}

function isMissingTable(err: { code?: string; message?: string }): boolean {
  const msg = err.message ?? '';
  return err.code === '42P01' || err.code === 'PGRST205' || /discovery_jobs/i.test(msg);
}

/** Insert-or-update one job. Swallows a missing table so deploys precede the migration. */
export async function saveDiscoveryJob(id: string, patch: DiscoveryJobPatch): Promise<void> {
  const row: Record<string, unknown> = { id };
  if (patch.scope !== undefined) row.scope = patch.scope;
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.ean !== undefined) row.ean = patch.ean;
  if (patch.supermarketId !== undefined) row.supermarket_id = patch.supermarketId;
  if (patch.progress !== undefined) row.progress = patch.progress;
  if (patch.chainSummary !== undefined) row.chain_summary = patch.chainSummary;
  if (patch.createdAt !== undefined) row.created_at = patch.createdAt;
  if (patch.finishedAt !== undefined) row.finished_at = patch.finishedAt;
  if (patch.failedReason !== undefined) row.failed_reason = patch.failedReason;

  const { error } = await db.from('discovery_jobs').upsert(row, { onConflict: 'id' });
  if (error) {
    if (isMissingTable(error)) {
      log.warn('discovery_jobs table missing — job stays in Redis only');
      return;
    }
    log.error({ err: error, jobId: id }, 'failed to persist discovery job');
  }
}

/**
 * Enqueue a discovery job and record it. Same payload the Sunday cron and
 * POST /v1/data/discover use, so the list cannot tell them apart.
 */
export async function enqueueDiscoveryJob(
  data: DiscoveryJobData,
): Promise<Job<DiscoveryJobData>> {
  const job = await getDiscoveryQueue().add('discover', data);
  if (job.id) {
    await saveDiscoveryJob(job.id, {
      scope: data.scope,
      status: 'queued',
      ean: 'ean' in data ? data.ean : null,
      supermarketId: 'supermarketId' in data ? data.supermarketId : null,
      progress: {},
      chainSummary: null,
      createdAt: new Date(job.timestamp).toISOString(),
      finishedAt: null,
      failedReason: null,
    });
  }
  return job;
}

/** Per-chain tallies for a sweep, from the worker's outcome list. */
export function rollupSweepChains(outcomes: DiscoverOutcome[]): ChainSweepStat[] {
  const byId = new Map<string, ChainSweepStat>();
  for (const o of outcomes) {
    const cur = byId.get(o.supermarketId) ?? {
      supermarket_id: o.supermarketId,
      ingested: 0,
      not_found: 0,
      errors: 0,
    };
    if (o.result === 'ingested') cur.ingested += 1;
    else if (o.result === 'not_found' || o.result === 'no_search') cur.not_found += 1;
    else if (o.result === 'error') cur.errors += 1;
    byId.set(o.supermarketId, cur);
  }
  return [...byId.values()].sort((a, b) => a.supermarket_id.localeCompare(b.supermarket_id));
}

/** Recent persisted jobs, newest first. Empty when the table is not there yet. */
export async function loadDiscoveryJobs(limit: number): Promise<DiscoveryJobRecord[]> {
  const { data, error } = await db
    .from('discovery_jobs')
    .select(
      'id, scope, status, ean, supermarket_id, progress, chain_summary, created_at, finished_at, failed_reason',
    )
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
  return (data ?? []) as DiscoveryJobRecord[];
}

/** Sweeps whose enqueue time is on or after `fromIso` (for the weekly rollup). */
export async function loadSweepsSince(
  fromIso: string,
): Promise<Array<{ id: string; createdAt: string; chains: ChainSweepStat[] }>> {
  const { data, error } = await db
    .from('discovery_jobs')
    .select('id, created_at, chain_summary')
    .eq('scope', 'sweep')
    .gte('created_at', fromIso)
    .order('created_at', { ascending: false });
  if (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
  return (data ?? []).map((r) => ({
    id: r.id as string,
    createdAt: r.created_at as string,
    chains: parseChainSummary(r.chain_summary),
  }));
}

function parseChainSummary(value: unknown): ChainSweepStat[] {
  if (!Array.isArray(value)) return [];
  const out: ChainSweepStat[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (typeof row.supermarket_id !== 'string') continue;
    out.push({
      supermarket_id: row.supermarket_id,
      ingested: typeof row.ingested === 'number' ? row.ingested : 0,
      not_found: typeof row.not_found === 'number' ? row.not_found : 0,
      errors: typeof row.errors === 'number' ? row.errors : 0,
    });
  }
  return out;
}

/** One persisted job, or null. */
export async function loadDiscoveryJob(id: string): Promise<DiscoveryJobRecord | null> {
  const { data, error } = await db
    .from('discovery_jobs')
    .select(
      'id, scope, status, ean, supermarket_id, progress, chain_summary, created_at, finished_at, failed_reason',
    )
    .eq('id', id)
    .maybeSingle();
  if (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
  return (data as DiscoveryJobRecord | null) ?? null;
}
