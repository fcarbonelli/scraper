/**
 * Daily orchestration: enqueues a scrape job for every active
 * supermarket_product across every active supermarket.
 *
 * Side effects:
 *   - Inserts one `scrape_runs` row (status='running').
 *   - Adds one BullMQ job per supermarket_product to the per-supermarket queue.
 *
 * Does NOT wait for jobs to complete — that's the finalizer's job.
 */

import { db } from '../shared/db.js';
import { logger } from '../shared/logger.js';
import {
  defaultJobOptions,
  getQueue,
  type ScrapeJobData,
} from '../shared/queue.js';

interface SupermarketRow {
  id: string;
  name: string;
}

interface SupermarketProductRow {
  id: string;
  supermarket_id: string;
  external_id: string;
  external_url: string | null;
}

/** Result summary for logs/observability. */
export interface RunDailyResult {
  scrapeRunId: string;
  totalEnqueued: number;
  bySupermarket: Record<string, number>;
}

/** Optional filters for {@link runDailyScrape}. */
export interface RunDailyOptions {
  /**
   * Restrict the run to a single supermarket id (e.g. `"maxi-carrefour"`).
   * When omitted, every active supermarket is enqueued.
   *
   * Used by `--supermarket=<id>` on the orchestrator's run-now flag — handy
   * for re-running just one site after a code change without paying the
   * cost (and rate-limit budget) of every other supermarket.
   */
  supermarketId?: string;
}

/**
 * Run the daily enqueue. Safe to call ad-hoc — it always creates a fresh
 * scrape_run row, never appends to an existing one.
 */
export async function runDailyScrape(
  opts: RunDailyOptions = {},
): Promise<RunDailyResult> {
  const startedAt = new Date().toISOString();

  // 1. Create scrape_runs row
  const runInsert = await db
    .from('scrape_runs')
    .insert({ started_at: startedAt, status: 'running' })
    .select('id')
    .single();
  if (runInsert.error) throw runInsert.error;
  const scrapeRunId = runInsert.data.id as string;
  const log = logger.child({ runId: scrapeRunId, filterSupermarket: opts.supermarketId });

  log.info({ startedAt }, 'starting daily scrape run');

  // 2. Load active supermarkets (optionally filtered to a single id)
  let smQuery = db
    .from('supermarkets')
    .select('id, name')
    .eq('is_active', true);
  if (opts.supermarketId) smQuery = smQuery.eq('id', opts.supermarketId);
  const smRes = await smQuery;
  if (smRes.error) throw smRes.error;
  const supermarkets = (smRes.data ?? []) as SupermarketRow[];

  if (supermarkets.length === 0) {
    log.warn('no active supermarkets — finalizing run with 0 jobs');
    await db
      .from('scrape_runs')
      .update({
        status: 'completed',
        finished_at: new Date().toISOString(),
        total_jobs: 0,
      })
      .eq('id', scrapeRunId);
    return { scrapeRunId, totalEnqueued: 0, bySupermarket: {} };
  }

  // 3. For each supermarket, load active products and enqueue
  const bySupermarket: Record<string, number> = {};
  let totalEnqueued = 0;

  for (const sm of supermarkets) {
    const productsRes = await db
      .from('supermarket_products')
      .select('id, supermarket_id, external_id, external_url')
      .eq('supermarket_id', sm.id)
      .eq('is_active', true);
    if (productsRes.error) {
      log.error(
        { err: productsRes.error, supermarket: sm.id },
        'failed to load supermarket_products, skipping',
      );
      continue;
    }
    const products = (productsRes.data ?? []) as SupermarketProductRow[];
    if (products.length === 0) {
      log.info({ supermarket: sm.id }, 'no active products for supermarket, skipping');
      bySupermarket[sm.id] = 0;
      continue;
    }

    const queue = getQueue(sm.id);

    // Use addBulk for efficiency — one Redis round-trip per supermarket.
    const jobs = products.map((p) => ({
      name: 'scrape' as const,
      data: {
        supermarketProductId: p.id,
        supermarketId: p.supermarket_id,
        externalId: p.external_id,
        externalUrl: p.external_url,
        scrapeRunId,
        attempt: 1,
      } satisfies ScrapeJobData,
      opts: defaultJobOptions(),
    }));

    await queue.addBulk(jobs);
    bySupermarket[sm.id] = products.length;
    totalEnqueued += products.length;
    log.info(
      { supermarket: sm.id, enqueued: products.length },
      'enqueued supermarket jobs',
    );
  }

  // 4. Stamp total_jobs so the finalizer knows when we're done
  await db
    .from('scrape_runs')
    .update({ total_jobs: totalEnqueued })
    .eq('id', scrapeRunId);

  log.info({ totalEnqueued, bySupermarket }, 'daily enqueue complete');
  return { scrapeRunId, totalEnqueued, bySupermarket };
}
