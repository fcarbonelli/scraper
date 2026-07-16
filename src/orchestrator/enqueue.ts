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
  config: { source_type?: string } | null;
}

interface SupermarketProductRow {
  id: string;
  supermarket_id: string;
  external_id: string;
  external_url: string | null;
  metadata: { source?: string } | null;
}

/**
 * Supermarket source types that have no web scraper adapter — their prices come
 * from humans (magazine review / in-store scans) and are re-emitted daily by
 * their own carry-forward. Enqueueing them would just fail every job with
 * "No adapter registered".
 */
const NON_SCRAPED_SOURCE_TYPES = new Set(['revista', 'instore']);

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

  // 2. Load active supermarkets (optionally filtered to a single id).
  //    Human-sourced chains (magazine "revista", in-store scans) are EXCLUDED:
  //    they have no scraper adapter and are re-emitted daily by their own
  //    carry-forward. Enqueueing them would just fail with "No adapter registered".
  let smQuery = db
    .from('supermarkets')
    .select('id, name, config')
    .eq('is_active', true);
  if (opts.supermarketId) smQuery = smQuery.eq('id', opts.supermarketId);
  const smRes = await smQuery;
  if (smRes.error) throw smRes.error;
  const supermarkets = ((smRes.data ?? []) as SupermarketRow[]).filter(
    (s) => !NON_SCRAPED_SOURCE_TYPES.has(s.config?.source_type ?? ''),
  );

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
      .select('id, supermarket_id, external_id, external_url, metadata')
      .eq('supermarket_id', sm.id)
      .eq('is_active', true);
    if (productsRes.error) {
      log.error(
        { err: productsRes.error, supermarket: sm.id },
        'failed to load supermarket_products, skipping',
      );
      continue;
    }
    // Skip in-store mappings even on a web-scraped chain (e.g. Maxiconsumo can
    // have both): they have a synthetic external_id, not a real URL, so a scrape
    // would always fail. Their prices are handled by carryForwardInStorePrices().
    const products = ((productsRes.data ?? []) as SupermarketProductRow[]).filter(
      (p) => p.metadata?.source !== 'instore',
    );
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

  // 4. Stamp total_jobs and per-supermarket plan so progress dashboards can
  // show pending work before every job has emitted a job_execution row.
  await db
    .from('scrape_runs')
    .update({
      total_jobs: totalEnqueued,
      metadata: {
        by_supermarket: bySupermarket,
        filter_supermarket: opts.supermarketId ?? null,
      },
    })
    .eq('id', scrapeRunId);

  log.info({ totalEnqueued, bySupermarket }, 'daily enqueue complete');
  return { scrapeRunId, totalEnqueued, bySupermarket };
}
