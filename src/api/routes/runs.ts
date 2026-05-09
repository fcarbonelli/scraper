/**
 * Scrape run routes.
 *
 *   GET /v1/runs       list of recent scrape runs
 *   GET /v1/runs/:id   single run with per-supermarket / per-tier breakdown
 *
 * Used by the operations dashboard to investigate what happened on a given day.
 */

import { Router, type Request, type Response } from 'express';
import { db } from '../../shared/db.js';
import { ApiError } from '../lib/apiError.js';
import { paginated, success } from '../lib/envelope.js';
import { parseQuery, PaginationQuery } from '../lib/parseQuery.js';

export const runsRouter = Router();

// =============================================================================
// GET /v1/runs
// =============================================================================

runsRouter.get('/', async (req: Request, res: Response) => {
  const q = parseQuery(req, PaginationQuery);
  const page = req.pagination?.page ?? q.page;
  const limit = req.pagination?.limit ?? q.limit;
  const offset = req.pagination?.offset ?? (page - 1) * limit;

  const { data, error, count } = await db
    .from('scrape_runs')
    .select(
      'id, started_at, finished_at, status, total_jobs, succeeded, failed, retried, metadata',
      { count: 'exact' },
    )
    .order('started_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;

  res.json(paginated(data ?? [], count ?? 0, page, limit));
});

// =============================================================================
// GET /v1/runs/:id
//
// Returns the run row + breakdown:
//   - per supermarket: total / succeeded / failed
//   - per tier (api/html/ai): how many succeeded
//   - top error types
// =============================================================================

interface JobRow {
  supermarket_product_id: string;
  attempt: number;
  status: string;
  error_type: string | null;
  tier_used: string | null;
}

interface MappingRow {
  id: string;
  supermarket_id: string;
}

runsRouter.get('/:id', async (req: Request, res: Response) => {
  // 1. Run row
  const runRes = await db
    .from('scrape_runs')
    .select(
      'id, started_at, finished_at, status, total_jobs, succeeded, failed, retried, metadata',
    )
    .eq('id', req.params.id)
    .maybeSingle();
  if (runRes.error) throw runRes.error;
  if (!runRes.data) throw ApiError.notFound('Run');

  // 2. All job_executions for this run (typically a few thousand at most)
  const jobsRes = await db
    .from('job_executions')
    .select('supermarket_product_id, attempt, status, error_type, tier_used')
    .eq('scrape_run_id', req.params.id);
  if (jobsRes.error) throw jobsRes.error;
  const jobs = (jobsRes.data ?? []) as JobRow[];

  // 3. Resolve mapping -> supermarket_id (one extra query, then index in JS)
  const mappingIds = Array.from(new Set(jobs.map((j) => j.supermarket_product_id)));
  let mappingsBySupermarket = new Map<string, string>(); // mappingId -> supermarketId
  if (mappingIds.length > 0) {
    const mappingsRes = await db
      .from('supermarket_products')
      .select('id, supermarket_id')
      .in('id', mappingIds);
    if (mappingsRes.error) throw mappingsRes.error;
    mappingsBySupermarket = new Map(
      ((mappingsRes.data ?? []) as MappingRow[]).map((m) => [m.id, m.supermarket_id]),
    );
  }

  // 4. Take the FINAL attempt per (supermarket_product_id) — this is the
  //    outcome we count in stats.
  const finalByMapping = new Map<string, JobRow>();
  for (const j of jobs) {
    const cur = finalByMapping.get(j.supermarket_product_id);
    if (!cur || j.attempt > cur.attempt) finalByMapping.set(j.supermarket_product_id, j);
  }

  // 5. Roll up the breakdowns
  const bySupermarket: Record<
    string,
    { total: number; succeeded: number; failed: number }
  > = {};
  const byTier: Record<string, number> = { api: 0, html: 0, ai: 0 };
  const byErrorType: Record<string, number> = {};

  for (const j of finalByMapping.values()) {
    const smId = mappingsBySupermarket.get(j.supermarket_product_id) ?? 'unknown';
    let bucket = bySupermarket[smId];
    if (!bucket) {
      bucket = { total: 0, succeeded: 0, failed: 0 };
      bySupermarket[smId] = bucket;
    }
    bucket.total += 1;
    if (j.status === 'success') {
      bucket.succeeded += 1;
      if (j.tier_used === 'api' || j.tier_used === 'html' || j.tier_used === 'ai') {
        byTier[j.tier_used] = (byTier[j.tier_used] ?? 0) + 1;
      }
    } else if (j.status === 'failed') {
      bucket.failed += 1;
      const key = j.error_type ?? 'unknown';
      byErrorType[key] = (byErrorType[key] ?? 0) + 1;
    }
  }

  // 6. Sort error types by frequency for nice display
  const topErrors = Object.entries(byErrorType)
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => ({ type, count }));

  res.json(
    success({
      run: runRes.data,
      breakdown: {
        bySupermarket,
        byTier,
        topErrors,
      },
    }),
  );
});
