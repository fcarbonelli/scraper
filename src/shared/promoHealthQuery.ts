/**
 * Load a run's priced snapshots and the prior week, then judge promo health.
 *
 * Pre-publish operator view, same scope as the price-outlier panel: the run
 * plus its recovery runs, including a day that is not published yet. Baseline
 * rows are web snapshots only (`scrape_run_id` set), so magazine and in-store
 * prices — which write run-less rows — do not set a chain's usual offer share.
 * The run's day is the UTC date of its earliest snapshot, the same day the
 * price-outlier panel uses.
 */

import { db, fetchAllPages } from './db.js';
import {
  baselineBounds,
  DEFAULT_PROMO_HEALTH_OPTIONS,
  judgePromoHealth,
  type PromoHealthChain,
  type PromoHealthOptions,
  type PromoObservation,
} from './promoHealth.js';

export interface RunPromoHealth {
  run_id: string;
  /** UTC day of the run's earliest snapshot. Null when the run has no rows yet. */
  date: string | null;
  windowDays: number;
  dropThresholdPct: number;
  minBaselineSharePct: number;
  minPriced: number;
  minDays: number;
  evaluated: number;
  count: number;
  chains: PromoHealthChain[];
}

interface MarketJoin {
  supermarket_id: string;
  supermarkets: { name: string | null } | { name: string | null }[] | null;
}

interface TodayRow {
  supermarket_product_id: string;
  scraped_at: string;
  price: number | string | null;
  list_price: number | string | null;
  promotions: unknown;
  supermarket_products: MarketJoin | MarketJoin[] | null;
}

interface HistoryRow {
  supermarket_product_id: string;
  scraped_at: string;
  price: number | string | null;
  list_price: number | string | null;
  promotions: unknown;
}

const MAPPING_CHUNK = 150;

function firstJoin<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function asPrice(value: number | string | null | undefined): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Recovery runs are those whose metadata.source_run_id points at this run. */
async function loadRecoveryRunIds(runId: string): Promise<string[]> {
  const { data, error } = await db
    .from('scrape_runs')
    .select('id')
    .eq('metadata->>source_run_id', runId);
  if (error) throw error;
  return (data ?? []).map((row) => row.id as string);
}

/** UTC calendar date of the run-set's earliest snapshot, or null. */
async function runSnapshotDate(runIds: string[]): Promise<string | null> {
  const { data, error } = await db
    .from('price_snapshots')
    .select('scraped_at')
    .in('scrape_run_id', runIds)
    .order('scraped_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data?.scraped_at ? String(data.scraped_at).slice(0, 10) : null;
}

/**
 * Latest ok, positively-priced snapshot per mapping across the run-set.
 * A mapping fixed by a recovery run keeps the newest snapshot.
 */
async function loadToday(runIds: string[]): Promise<PromoObservation[]> {
  const rows = await fetchAllPages<TodayRow>((from, to) =>
    db
      .from('price_snapshots')
      .select(
        'supermarket_product_id, scraped_at, price, list_price, promotions, supermarket_products:supermarket_product_id ( supermarket_id, supermarkets:supermarket_id ( name ) )',
      )
      .in('scrape_run_id', runIds)
      .eq('status', 'ok')
      .gt('price', 0)
      .order('scraped_at', { ascending: false })
      .range(from, to),
  );

  const latest = new Map<string, PromoObservation>();
  for (const row of rows) {
    if (latest.has(row.supermarket_product_id)) continue;
    const price = asPrice(row.price);
    if (price == null || price <= 0) continue;
    const mapping = firstJoin(row.supermarket_products);
    const market = firstJoin(mapping?.supermarkets);
    const supermarketId = mapping?.supermarket_id ?? 'unknown';
    latest.set(row.supermarket_product_id, {
      supermarketProductId: row.supermarket_product_id,
      supermarketId,
      supermarketName: market?.name?.trim() || supermarketId,
      scrapedAt: row.scraped_at,
      price,
      listPrice: asPrice(row.list_price),
      promotions: row.promotions,
    });
  }
  return [...latest.values()];
}

/** Prior web snapshots for the mappings priced today, inside the baseline window. */
async function loadHistory(
  today: PromoObservation[],
  date: string,
  windowDays: number,
): Promise<PromoObservation[]> {
  if (today.length === 0) return [];
  const bounds = baselineBounds(date, windowDays);
  const chainOf = new Map(today.map((row) => [row.supermarketProductId, row]));
  const ids = today.map((row) => row.supermarketProductId);
  const out: PromoObservation[] = [];

  for (let i = 0; i < ids.length; i += MAPPING_CHUNK) {
    const chunk = ids.slice(i, i + MAPPING_CHUNK);
    const rows = await fetchAllPages<HistoryRow>((from, to) =>
      db
        .from('price_snapshots')
        .select('supermarket_product_id, scraped_at, price, list_price, promotions')
        .in('supermarket_product_id', chunk)
        .gte('scraped_at', bounds.startIso)
        .lt('scraped_at', bounds.endIso)
        .eq('status', 'ok')
        .gt('price', 0)
        .not('scrape_run_id', 'is', null)
        .order('id', { ascending: true })
        .range(from, to),
    );
    for (const row of rows) {
      const price = asPrice(row.price);
      if (price == null || price <= 0) continue;
      const known = chainOf.get(row.supermarket_product_id);
      out.push({
        supermarketProductId: row.supermarket_product_id,
        supermarketId: known?.supermarketId ?? '',
        supermarketName: known?.supermarketName ?? '',
        scrapedAt: row.scraped_at,
        price,
        listPrice: asPrice(row.list_price),
        promotions: row.promotions,
      });
    }
  }
  return out;
}

/**
 * Promo-health flags for one run. Returns an empty verdict when the run
 * has no snapshots yet.
 */
export async function computeRunPromoHealth(
  runId: string,
  opts: Partial<PromoHealthOptions> = {},
): Promise<RunPromoHealth> {
  const options: PromoHealthOptions = { ...DEFAULT_PROMO_HEALTH_OPTIONS, ...opts };
  const runIds = [runId, ...(await loadRecoveryRunIds(runId))];
  const date = await runSnapshotDate(runIds);

  const empty: RunPromoHealth = {
    run_id: runId,
    date,
    windowDays: options.windowDays,
    dropThresholdPct: options.dropThresholdPct,
    minBaselineSharePct: options.minBaselineSharePct,
    minPriced: options.minPriced,
    minDays: options.minDays,
    evaluated: 0,
    count: 0,
    chains: [],
  };
  if (!date) return empty;

  const today = await loadToday(runIds);
  const history = await loadHistory(today, date, options.windowDays);
  const verdict = judgePromoHealth(date, today, history, options);
  return {
    ...empty,
    evaluated: verdict.evaluated,
    count: verdict.chains.length,
    chains: verdict.chains,
  };
}
