/**
 * Price-outlier detection for the daily-review "publicación" panel.
 *
 * Goal: for a run's day, surface products whose scraped price deviates by ≥30%
 * from a baseline, so the operator can eyeball promo-driven or suspicious price
 * swings BEFORE publishing. This is a pre-publish operator view, so it reads the
 * raw `price_snapshots` (scoped to the run + its recovery runs) — it sees the
 * pending/unapproved day exactly like the `preview=true` export does.
 *
 * Baseline (decision): each mapping's OWN median price over the last N days
 * (default 30), computed strictly BEFORE the run's day. Self-history median is
 * what catches "the price changed today" (a promo, a spike, or a data error),
 * and the median is robust to a single prior promo day polluting the window.
 * A mapping with fewer than `minHistory` prior points is skipped (can't judge).
 *
 * deviation_pct = (price - baseline) / baseline * 100, sign kept so the front
 * can distinguish drops (negative) from spikes (positive). A row is an outlier
 * when |deviation_pct| >= threshold (default 30).
 *
 * Extreme low outliers are EXCLUDED: those are already detected+suppressed by
 * `runAnomalySuppression` at finalize time (they become `out_of_stock`, so they
 * usually aren't `status='ok'` here anyway). We additionally drop their snapshot
 * ids so this panel only ever surfaces "normal" deviations and never double-
 * reports what's flagged elsewhere.
 *
 * Pure logic over the DB; called by the API route.
 */

import { db, fetchAllPages } from './db.js';
import { runAnomalySuppression } from './priceAnomaly.js';
import type { Promotion } from '../adapters/types.js';

// Chunk mapping ids for the history `.in()` query so a large filter never
// overflows the request URL. Each chunk is still paged past the 1000-row cap.
const MAPPING_CHUNK = 150;

/** Tunables for outlier detection. */
export interface PriceOutlierOptions {
  /** Flag when |deviation_pct| >= this (percent). Default 30. */
  threshold: number;
  /** How many days of self-history feed the baseline median. Default 30. */
  windowDays: number;
  /** Minimum prior history points before a baseline is trusted. Default 2. */
  minHistory: number;
}

export const DEFAULT_OUTLIER_OPTIONS: PriceOutlierOptions = {
  threshold: 30,
  windowDays: 30,
  minHistory: 2,
};

/** One flagged product for the review panel. */
export interface PriceOutlier {
  supermarket_product_id: string;
  ean: string | null;
  name: string;
  supermarket_id: string;
  /** Product URL at the supermarket (same source as RunReviewGap.external_url). */
  external_url: string | null;
  /** Today's scraped price for this mapping. */
  price: number;
  /** The self-history median it's compared against. */
  baseline: number;
  /** Signed % deviation from baseline (negative = drop, positive = spike). */
  deviation_pct: number;
  /** Present when the scraped snapshot carried promotions (helps spot promos). */
  promotions?: Promotion[];
}

export interface RunPriceOutliers {
  run_id: string;
  /** Calendar day (UTC) the outliers were computed for. */
  date: string | null;
  baseline: { method: 'self-history-median'; windowDays: number; minHistory: number };
  threshold: number;
  count: number;
  priceOutliers: PriceOutlier[];
}

// -----------------------------------------------------------------------------
// Row shapes
// -----------------------------------------------------------------------------

interface SpJoin {
  supermarket_id: string;
  external_url: string | null;
  products:
    | { ean: string | null; name: string | null }
    | { ean: string | null; name: string | null }[]
    | null;
}
interface RunSnapRow {
  id: string;
  supermarket_product_id: string;
  scraped_at: string;
  price: number | null;
  promotions: Promotion[] | null;
  supermarket_products: SpJoin | SpJoin[] | null;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function median(nums: number[]): number {
  if (nums.length === 0) return NaN;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function firstJoin<T>(v: T | T[] | null | undefined): T | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

/** Recovery runs are those whose metadata.source_run_id points at this run. */
async function loadRecoveryRunIds(runId: string): Promise<string[]> {
  const { data, error } = await db
    .from('scrape_runs')
    .select('id')
    .eq('metadata->>source_run_id', runId);
  if (error) throw error;
  return (data ?? []).map((r) => r.id as string);
}

/** The (UTC) calendar date of the run-set's earliest snapshot, or null. */
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
 * Latest `ok`, positively-priced snapshot per mapping across the run-set. A
 * mapping fixed by a recovery run keeps the newest snapshot (its real price).
 */
async function loadRunOkSnapshots(runIds: string[]): Promise<RunSnapRow[]> {
  const rows = await fetchAllPages<RunSnapRow>((from, to) =>
    db
      .from('price_snapshots')
      .select(
        'id, supermarket_product_id, scraped_at, price, promotions, supermarket_products:supermarket_product_id ( supermarket_id, external_url, products:product_id ( ean, name ) )',
      )
      .in('scrape_run_id', runIds)
      .eq('status', 'ok')
      .gt('price', 0)
      .order('scraped_at', { ascending: false })
      .range(from, to),
  );

  // Keep only the newest snapshot per mapping (rows are already desc by date).
  const latest = new Map<string, RunSnapRow>();
  for (const r of rows) {
    if (!latest.has(r.supermarket_product_id)) latest.set(r.supermarket_product_id, r);
  }
  return [...latest.values()];
}

/**
 * Per-mapping price history (median input): all `ok`, positively-priced
 * snapshots in [date - windowDays, date), keyed by supermarket_product_id.
 */
async function loadHistory(
  mappingIds: string[],
  date: string,
  windowDays: number,
): Promise<Map<string, number[]>> {
  const dayStart = `${date}T00:00:00.000Z`;
  const histStart = new Date(new Date(dayStart).getTime() - windowDays * 86_400_000).toISOString();

  const byMapping = new Map<string, number[]>();
  for (let i = 0; i < mappingIds.length; i += MAPPING_CHUNK) {
    const chunk = mappingIds.slice(i, i + MAPPING_CHUNK);
    const rows = await fetchAllPages<{ supermarket_product_id: string; price: number | null }>(
      (from, to) =>
        db
          .from('price_snapshots')
          .select('supermarket_product_id, price')
          .in('supermarket_product_id', chunk)
          .gte('scraped_at', histStart)
          .lt('scraped_at', dayStart)
          .eq('status', 'ok')
          .gt('price', 0)
          .order('id', { ascending: true })
          .range(from, to),
    );
    for (const h of rows) {
      if (h.price == null) continue;
      const arr = byMapping.get(h.supermarket_product_id) ?? [];
      arr.push(h.price);
      byMapping.set(h.supermarket_product_id, arr);
    }
  }
  return byMapping;
}

// -----------------------------------------------------------------------------
// Compute
// -----------------------------------------------------------------------------

/**
 * Compute the ≥threshold price outliers for a run's day. Reads raw snapshots so
 * it works on a still-pending (unpublished) run.
 */
export async function computeRunPriceOutliers(
  runId: string,
  opts: Partial<PriceOutlierOptions> = {},
): Promise<RunPriceOutliers> {
  const options: PriceOutlierOptions = { ...DEFAULT_OUTLIER_OPTIONS, ...opts };

  const recoveryRunIds = await loadRecoveryRunIds(runId);
  const runIds = [runId, ...recoveryRunIds];

  const date = await runSnapshotDate(runIds);
  const emptyResult: RunPriceOutliers = {
    run_id: runId,
    date,
    baseline: {
      method: 'self-history-median',
      windowDays: options.windowDays,
      minHistory: options.minHistory,
    },
    threshold: options.threshold,
    count: 0,
    priceOutliers: [],
  };
  if (!date) return emptyResult;

  const [snapshots, excludedFlags] = await Promise.all([
    loadRunOkSnapshots(runIds),
    // Same detection the finalizer uses — drop the extreme low outliers so this
    // panel only shows "normal" swings.
    runAnomalySuppression({ date, dryRun: true }),
  ]);
  const excludedSnapshotIds = new Set(excludedFlags.map((f) => f.snapshotId));

  const history = await loadHistory(
    snapshots.map((s) => s.supermarket_product_id),
    date,
    options.windowDays,
  );

  const outliers: PriceOutlier[] = [];
  for (const snap of snapshots) {
    if (snap.price == null || snap.price <= 0) continue;
    if (excludedSnapshotIds.has(snap.id)) continue;

    const hist = history.get(snap.supermarket_product_id) ?? [];
    if (hist.length < options.minHistory) continue;

    const baseline = median(hist);
    if (!Number.isFinite(baseline) || baseline <= 0) continue;

    const deviationPct = ((snap.price - baseline) / baseline) * 100;
    if (Math.abs(deviationPct) < options.threshold) continue;

    const sp = firstJoin(snap.supermarket_products);
    const prod = firstJoin(sp?.products);
    const promotions = Array.isArray(snap.promotions) && snap.promotions.length > 0
      ? snap.promotions
      : undefined;

    outliers.push({
      supermarket_product_id: snap.supermarket_product_id,
      ean: prod?.ean ?? null,
      name: prod?.name ?? '',
      supermarket_id: sp?.supermarket_id ?? 'unknown',
      external_url: sp?.external_url ?? null,
      price: snap.price,
      baseline: Number(baseline.toFixed(2)),
      deviation_pct: Number(deviationPct.toFixed(1)),
      ...(promotions ? { promotions } : {}),
    });
  }

  // Biggest swings first (by magnitude) so the operator triages the worst cases.
  outliers.sort((a, b) => Math.abs(b.deviation_pct) - Math.abs(a.deviation_pct));

  return { ...emptyResult, count: outliers.length, priceOutliers: outliers };
}
