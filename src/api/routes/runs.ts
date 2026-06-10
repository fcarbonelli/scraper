/**
 * Scrape run routes.
 *
 *   GET /v1/runs       list of recent scrape runs
 *   GET /v1/runs/:id   single run with per-supermarket / per-tier breakdown
 *
 * Used by the operations dashboard to investigate what happened on a given day.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { db, fetchAllPages, fetchInChunks } from '../../shared/db.js';
import { ApiError } from '../lib/apiError.js';
import { paginated, success } from '../lib/envelope.js';
import { parseBody, parseQuery, PaginationQuery } from '../lib/parseQuery.js';
import { defaultJobOptions, getQueue, type ScrapeJobData } from '../../shared/queue.js';
import {
  loadRunDiagnostics,
  type FinalJobOutcome,
  type SupermarketProductDebugRow,
} from '../../shared/runDiagnostics.js';

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

interface SnapshotRow {
  price: number;
  list_price: number | null;
  unit_price: number | null;
  unit_price_per: string | null;
  in_stock: boolean;
  currency: string;
  tier_used: string;
  scraped_at: string;
}

interface EnqueuedScrapeJob {
  name: 'scrape';
  data: ScrapeJobData;
  opts: ReturnType<typeof defaultJobOptions>;
}

function firstJoined<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function pathParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw ApiError.badRequest(`Missing path parameter: ${name}`);
  }
  return value;
}

async function loadMappingDetails(
  mappingIds: string[],
): Promise<Map<string, SupermarketProductDebugRow>> {
  if (mappingIds.length === 0) return new Map();

  const rows = await fetchInChunks<SupermarketProductDebugRow>(mappingIds, (chunk) =>
    db
      .from('supermarket_products')
      .select(
        `
      id,
      supermarket_id,
      external_id,
      external_url,
      product_id,
      products:product_id (
        id,
        name,
        brand,
        category,
        metadata
      ),
      supermarkets:supermarket_id (
        id,
        name
      )
    `,
      )
      .in('id', chunk),
  );

  return new Map(rows.map((m) => [m.id, m]));
}

async function loadLatestSnapshot(
  supermarketProductId: string,
): Promise<SnapshotRow | null> {
  const { data, error } = await db
    .from('price_snapshots')
    .select(
      'price, list_price, unit_price, unit_price_per, in_stock, currency, tier_used, scraped_at',
    )
    .eq('supermarket_product_id', supermarketProductId)
    .order('scraped_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data as SnapshotRow | null;
}

async function failedOutcomesForRun(
  runId: string,
): Promise<{
  failures: FinalJobOutcome[];
  detailsByMapping: Map<string, SupermarketProductDebugRow>;
}> {
  const diagnostics = await loadRunDiagnostics(runId);
  if (!diagnostics) throw ApiError.notFound('Run');

  const failures = diagnostics.finalOutcomes.filter((j) => j.status === 'failed');
  const detailsByMapping = await loadMappingDetails(
    failures.map((j) => j.supermarket_product_id),
  );

  return { failures, detailsByMapping };
}

function filterFailedOutcomes(
  failures: FinalJobOutcome[],
  detailsByMapping: Map<string, SupermarketProductDebugRow>,
  filters: { supermarket?: string; error_type?: string; supermarket_product_ids?: string[] },
): FinalJobOutcome[] {
  const allowedIds = filters.supermarket_product_ids
    ? new Set(filters.supermarket_product_ids)
    : null;

  return failures.filter((failure) => {
    if (allowedIds && !allowedIds.has(failure.supermarket_product_id)) return false;
    if (filters.error_type && failure.error_type !== filters.error_type) return false;
    if (filters.supermarket) {
      const mapping = detailsByMapping.get(failure.supermarket_product_id);
      if (mapping?.supermarket_id !== filters.supermarket) return false;
    }
    return true;
  });
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

  // 2. All job_executions for this run — paged past the 1000-row response cap
  //    (a daily run across many supermarkets easily exceeds 1000 rows).
  const jobs = await fetchAllPages<JobRow>((from, to) =>
    db
      .from('job_executions')
      .select('supermarket_product_id, attempt, status, error_type, tier_used')
      .eq('scrape_run_id', req.params.id)
      .order('id', { ascending: true })
      .range(from, to),
  );

  // 3. Resolve mapping -> supermarket_id (chunked so a large id filter does not
  //    overflow the request URL and 400), then index in JS.
  const mappingIds = Array.from(new Set(jobs.map((j) => j.supermarket_product_id)));
  const mappingRows = await fetchInChunks<MappingRow>(mappingIds, (chunk) =>
    db.from('supermarket_products').select('id, supermarket_id').in('id', chunk),
  );
  const mappingsBySupermarket = new Map<string, string>(
    mappingRows.map((m) => [m.id, m.supermarket_id]),
  );

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
  const byTier: Record<string, number> = { api: 0, html: 0, ai: 0, manual: 0 };
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
      if (
        j.tier_used === 'api' ||
        j.tier_used === 'html' ||
        j.tier_used === 'ai' ||
        j.tier_used === 'manual'
      ) {
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

// =============================================================================
// GET /v1/runs/:id/progress
//
// Live progress for dashboards. Unlike the final run row, this updates while
// the run is still active and includes pending/retrying counts.
// =============================================================================

runsRouter.get('/:id/progress', async (req: Request, res: Response) => {
  const runId = pathParam(req, 'id');
  const diagnostics = await loadRunDiagnostics(runId);
  if (!diagnostics) throw ApiError.notFound('Run');

  res.json(
    success({
      run: diagnostics.run,
      progress: diagnostics.progress,
    }),
  );
});

// =============================================================================
// GET /v1/runs/:id/failures
//
// Product-level failure drilldown for operations/debugging.
// =============================================================================

const FailuresQuery = PaginationQuery.extend({
  supermarket: z.string().trim().min(1).optional(),
  error_type: z.string().trim().min(1).optional(),
});

runsRouter.get('/:id/failures', async (req: Request, res: Response) => {
  const runId = pathParam(req, 'id');
  const q = parseQuery(req, FailuresQuery);
  const page = req.pagination?.page ?? q.page;
  const limit = req.pagination?.limit ?? q.limit;
  const offset = req.pagination?.offset ?? (page - 1) * limit;

  const { failures, detailsByMapping } = await failedOutcomesForRun(runId);
  const filtered = filterFailedOutcomes(failures, detailsByMapping, q);
  const pageItems = filtered.slice(offset, offset + limit);

  const rows = await Promise.all(
    pageItems.map(async (failure) => {
      const mapping = detailsByMapping.get(failure.supermarket_product_id);
      const product = firstJoined(mapping?.products);
      const supermarket = firstJoined(mapping?.supermarkets);

      return {
        job_execution_id: failure.id,
        supermarket_product_id: failure.supermarket_product_id,
        attempts: failure.attempts,
        final_attempt: failure.attempt,
        status: failure.status,
        error_type: failure.error_type,
        error_message: failure.error_message,
        error_stack: failure.error_stack,
        duration_ms: failure.duration_ms,
        started_at: failure.started_at,
        finished_at: failure.finished_at,
        supermarket: supermarket
          ? { id: supermarket.id, name: supermarket.name }
          : mapping
            ? { id: mapping.supermarket_id, name: mapping.supermarket_id }
            : null,
        supermarket_product: mapping
          ? {
              id: mapping.id,
              external_id: mapping.external_id,
              external_url: mapping.external_url,
            }
          : null,
        product: product
          ? {
              id: product.id,
              name: product.name,
              brand: product.brand,
              category: product.category,
              metadata: product.metadata,
            }
          : null,
        latest_snapshot: await loadLatestSnapshot(failure.supermarket_product_id),
      };
    }),
  );

  res.json(paginated(rows, filtered.length, page, limit));
});

// =============================================================================
// POST /v1/runs/:id/retry-failed
//
// Creates a fresh recovery run with jobs for selected failures from the source
// run. This keeps daily run history immutable and gives retries their own
// progress/alerts.
// =============================================================================

const RetryFailedBody = z.object({
  supermarket: z.string().trim().min(1).optional(),
  error_type: z.string().trim().min(1).optional(),
  supermarket_product_ids: z.array(z.string().uuid()).min(1).max(500).optional(),
  max: z.number().int().min(1).max(1000).default(500),
});

runsRouter.post('/:id/retry-failed', async (req: Request, res: Response) => {
  const sourceRunId = pathParam(req, 'id');
  const body = parseBody(req, RetryFailedBody);
  const { failures, detailsByMapping } = await failedOutcomesForRun(sourceRunId);
  const selected = filterFailedOutcomes(failures, detailsByMapping, body)
    .filter((failure) => detailsByMapping.has(failure.supermarket_product_id))
    .slice(0, body.max);

  if (selected.length === 0) {
    res.json(
      success({
        source_run_id: sourceRunId,
        retry_run_id: null,
        total_enqueued: 0,
        by_supermarket: {},
      }),
    );
    return;
  }

  const bySupermarket: Record<string, number> = {};
  for (const failure of selected) {
    const mapping = detailsByMapping.get(failure.supermarket_product_id);
    if (!mapping) continue;
    bySupermarket[mapping.supermarket_id] = (bySupermarket[mapping.supermarket_id] ?? 0) + 1;
  }

  const runInsert = await db
    .from('scrape_runs')
    .insert({
      started_at: new Date().toISOString(),
      status: 'running',
      total_jobs: selected.length,
      metadata: {
        recovery: true,
        source_run_id: sourceRunId,
        by_supermarket: bySupermarket,
        filters: {
          supermarket: body.supermarket ?? null,
          error_type: body.error_type ?? null,
          supermarket_product_ids: body.supermarket_product_ids ?? null,
        },
      },
    })
    .select('id')
    .single();
  if (runInsert.error) throw runInsert.error;
  const retryRunId = runInsert.data.id as string;

  const jobsBySupermarket = new Map<string, EnqueuedScrapeJob[]>();
  for (const failure of selected) {
    const mapping = detailsByMapping.get(failure.supermarket_product_id);
    if (!mapping) continue;

    const jobs = jobsBySupermarket.get(mapping.supermarket_id) ?? [];
    jobs.push({
      name: 'scrape',
      data: {
        supermarketProductId: mapping.id,
        supermarketId: mapping.supermarket_id,
        externalId: mapping.external_id,
        externalUrl: mapping.external_url,
        scrapeRunId: retryRunId,
        attempt: 1,
      },
      opts: defaultJobOptions(),
    });
    jobsBySupermarket.set(mapping.supermarket_id, jobs);
  }

  for (const [supermarketId, jobs] of jobsBySupermarket) {
    await getQueue(supermarketId).addBulk(jobs);
  }

  res.status(201).json(
    success({
      source_run_id: sourceRunId,
      retry_run_id: retryRunId,
      total_enqueued: selected.length,
      by_supermarket: bySupermarket,
    }),
  );
});
