/**
 * Analytics overview for the "Resumen" landing dashboard.
 *
 * Powers `GET /v1/data/analytics/overview`. This file is the HTTP/DB layer:
 * it loads the published snapshot set and hands it to
 * {@link assembleAnalyticsOverview} (pure math, no I/O).
 *
 * Memory matters here. The API process is memory-capped in `ecosystem.config.cjs`.
 * The first version of this endpoint embedded product + supermarket + scrape_run
 * on every snapshot row; paging ~100k of those objects blew the cap, PM2
 * SIGKILL'd the process mid-request, and Caddy's 502 had no CORS headers —
 * which the browser reported as a CORS failure on Resumen. We now load
 * dimension tables once and page only slim snapshot columns.
 */

import { db, fetchAllPages, PG_PAGE_SIZE } from '../../shared/db.js';
import { logger } from '../../shared/logger.js';
import { CLIENT_DATA_FLOOR_DATE, todayInBuenosAires } from './exportClientBase.js';
import {
  assembleAnalyticsOverview,
  resolveAnalyticsWindow,
  type AnalyticsOverview,
  type AnalyticsOverviewParams,
  type SnapRow,
} from './analyticsOverviewCompute.js';

export type {
  AnalyticsOverview,
  AnalyticsOverviewParams,
  AnalyticsRange,
  AvailabilityAnalytics,
  BasketAnalytics,
  CategoryInflation,
  CompetitivenessAnalytics,
  MoversAnalytics,
  PromotionAnalytics,
  SnapRow,
} from './analyticsOverviewCompute.js';
export { assembleAnalyticsOverview } from './analyticsOverviewCompute.js';

const log = logger.child({ component: 'analytics-overview' });

/** Slim snapshot columns — no nested embeds (those were the 300MB killer). */
const SNAPSHOT_COLUMNS =
  'supermarket_product_id, scraped_at, price, list_price, in_stock, status, offer_price_1, offer_price_2, unit_discount, promotion_1, promotion_2, scrape_run_id';

const PUBLISHED_STATUSES = ['ok', 'out_of_stock', 'not_found', 'delisted'] as const;

/** How many snapshot page fetches to run at once. */
const FETCH_CONCURRENCY = 6;

interface MappingInfo {
  cellId: string;
  supermarketId: string;
  supermarketName: string;
  productId: string;
  productName: string;
  ean: string;
  category: string | null;
}

interface MappingRow {
  id: string;
  supermarket_id: string;
  product_id: string;
  is_active: boolean;
}

interface ProductRow {
  id: string;
  name: string;
  category: string | null;
  ean: string | null;
}

interface SupermarketRow {
  id: string;
  name: string;
  cadena_display_name: string | null;
  is_active: boolean;
}

interface SlimSnapRow {
  supermarket_product_id: string;
  scraped_at: string;
  price: unknown;
  list_price: unknown;
  in_stock: boolean | null;
  status: string;
  offer_price_1: unknown;
  offer_price_2: unknown;
  unit_discount: unknown;
  promotion_1: string | null;
  promotion_2: string | null;
  scrape_run_id: string | null;
}

/** Coerce a PostgREST numeric (number|string|null) to a finite number or null. */
function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Run `fn` over `items` with at most `limit` in flight; preserves input order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Active mappings on active chains with a real EAN, keyed by mapping id.
 * Three flat reads instead of a nested embed on every snapshot.
 */
async function loadActiveMappings(
  supermarketIds: string[] | null,
): Promise<Map<string, MappingInfo>> {
  const mappingQuery = (from: number, to: number) => {
    let q = db
      .from('supermarket_products')
      .select('id, supermarket_id, product_id, is_active')
      .eq('is_active', true)
      .range(from, to);
    if (supermarketIds && supermarketIds.length > 0) {
      q = q.in('supermarket_id', supermarketIds);
    }
    return q;
  };

  const [mappings, products, supers] = await Promise.all([
    fetchAllPages<MappingRow>(mappingQuery),
    fetchAllPages<ProductRow>((from, to) =>
      db.from('products').select('id, name, category, ean').range(from, to),
    ),
    fetchAllPages<SupermarketRow>((from, to) =>
      db
        .from('supermarkets')
        .select('id, name, cadena_display_name, is_active')
        .eq('is_active', true)
        .range(from, to),
    ),
  ]);

  const productById = new Map(products.map((p) => [p.id, p]));
  const superById = new Map(supers.map((s) => [s.id, s]));
  const out = new Map<string, MappingInfo>();

  for (const m of mappings) {
    if (!m.is_active) continue;
    const sm = superById.get(m.supermarket_id);
    if (!sm || !sm.is_active) continue;
    const prod = productById.get(m.product_id);
    if (!prod) continue;
    const ean = prod.ean == null ? '' : String(prod.ean).trim();
    if (!ean) continue;

    out.set(m.id, {
      cellId: m.id,
      supermarketId: sm.id,
      supermarketName: sm.cadena_display_name ?? sm.name,
      productId: prod.id,
      productName: prod.name,
      ean,
      category: prod.category == null ? null : String(prod.category),
    });
  }
  return out;
}

/** Ids of scrape runs the client is allowed to see. */
async function loadPublishedRunIds(): Promise<Set<string>> {
  const rows = await fetchAllPages<{ id: string }>((from, to) =>
    db.from('scrape_runs').select('id').eq('review_status', 'published').range(from, to),
  );
  return new Set(rows.map((r) => r.id));
}

/**
 * Published snapshots in `[fromDate, toDate]` (BA calendar days), joined in
 * Node against the mapping + published-run lookups.
 */
async function fetchPublishedSnapshots(
  fromDate: string,
  toDate: string,
  supermarketIds: string[] | null,
): Promise<SnapRow[]> {
  const lowerUtc = new Date(`${fromDate}T00:00:00-03:00`).toISOString();
  const upperUtc = new Date(`${toDate}T23:59:59.999-03:00`).toISOString();

  const [mappings, publishedRuns] = await Promise.all([
    loadActiveMappings(supermarketIds),
    loadPublishedRunIds(),
  ]);

  if (mappings.size === 0) return [];

  const build = (opts?: { count: 'exact'; head: true }) => {
    let q = db
      .from('price_snapshots')
      .select(SNAPSHOT_COLUMNS, opts)
      .in('status', [...PUBLISHED_STATUSES])
      .gte('scraped_at', lowerUtc)
      .lte('scraped_at', upperUtc);
    return q;
  };

  const { count, error: countErr } = await build({ count: 'exact', head: true });
  if (countErr) throw countErr;
  const total = count ?? 0;
  if (total === 0) return [];

  const pageCount = Math.ceil(total / PG_PAGE_SIZE);
  const pageIndexes = Array.from({ length: pageCount }, (_, i) => i);

  const pages = await mapWithConcurrency(pageIndexes, FETCH_CONCURRENCY, async (i) => {
    const from = i * PG_PAGE_SIZE;
    const { data, error } = await build()
      .order('id', { ascending: true })
      .range(from, from + PG_PAGE_SIZE - 1);
    if (error) throw error;
    return (data ?? []) as SlimSnapRow[];
  });

  const rows: SnapRow[] = [];
  for (const r of pages.flat()) {
    const mapping = mappings.get(r.supermarket_product_id);
    if (!mapping) continue;

    // Run-less snapshots publish immediately; otherwise the run must be published.
    if (r.scrape_run_id && !publishedRuns.has(r.scrape_run_id)) continue;

    rows.push({
      scrapedAt: String(r.scraped_at),
      price: num(r.price),
      listPrice: num(r.list_price),
      inStock: r.in_stock === true,
      status: String(r.status),
      offer1: num(r.offer_price_1),
      offer2: num(r.offer_price_2),
      unitDiscount: num(r.unit_discount),
      promotion1: r.promotion_1 == null ? null : String(r.promotion_1),
      promotion2: r.promotion_2 == null ? null : String(r.promotion_2),
      reviewStatus: r.scrape_run_id ? 'published' : null,
      cellId: mapping.cellId,
      supermarketId: mapping.supermarketId,
      supermarketName: mapping.supermarketName,
      productId: mapping.productId,
      productName: mapping.productName,
      ean: mapping.ean,
      category: mapping.category,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Public entry point (+ short-lived in-memory cache + single-flight)
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 10 * 60 * 1000;
const overviewCache = new Map<string, { at: number; value: AnalyticsOverview }>();
/** In-flight computes, so two cold Resumen loads share one aggregation. */
const inflight = new Map<string, Promise<AnalyticsOverview>>();

function cacheKey(params: AnalyticsOverviewParams): string {
  return JSON.stringify({
    from: params.from ?? null,
    to: params.to ?? null,
    window: params.window ?? null,
    supermarket: params.supermarket
      ? params.supermarket
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
          .sort()
          .join(',')
      : null,
  });
}

/**
 * Build the full analytics overview for the given window, memoized for
 * {@link CACHE_TTL_MS}. Concurrent callers with the same key share one compute.
 */
export async function buildAnalyticsOverview(
  params: AnalyticsOverviewParams,
): Promise<AnalyticsOverview> {
  const key = cacheKey(params);

  const hit = overviewCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const existing = inflight.get(key);
  if (existing) return existing;

  const pending = computeAnalyticsOverview(params)
    .then((value) => {
      overviewCache.set(key, { at: Date.now(), value });
      for (const [k, v] of overviewCache) {
        if (Date.now() - v.at >= CACHE_TTL_MS) overviewCache.delete(k);
      }
      return value;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, pending);
  return pending;
}

/**
 * Resolve the window, load slim published snapshots, and assemble the payload.
 */
async function computeAnalyticsOverview(
  params: AnalyticsOverviewParams,
): Promise<AnalyticsOverview> {
  const t0 = Date.now();
  const { from, to, windowDays } = resolveAnalyticsWindow(
    params,
    todayInBuenosAires(),
    CLIENT_DATA_FLOOR_DATE,
  );

  if (from > to) {
    return assembleAnalyticsOverview([], { from, to }, windowDays);
  }

  const supermarketIds = params.supermarket
    ? params.supermarket
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    : null;

  const rows = await fetchPublishedSnapshots(from, to, supermarketIds);
  const overview = assembleAnalyticsOverview(
    rows,
    { from, to },
    windowDays,
    supermarketIds === null,
  );

  log.info(
    {
      ms: Date.now() - t0,
      rows: rows.length,
      range: overview.range,
      windowDays,
      supermarket: supermarketIds,
    },
    'analytics overview assembled',
  );
  return overview;
}
