/**
 * Pure in-store outlier detection (no DB).
 *
 * Split out of `priceOutliers.ts` so unit tests can import this without
 * pulling in the side-effecting Supabase client. The loader + API live
 * in `priceOutliers.ts`.
 *
 * Baseline, in priority order (first source with enough signal wins):
 *   1. SELF-HISTORY — previous in-store entries for the same
 *      supermarket + EAN.
 *   2. CROSS-STORE — other in-store chains' prices for the same EAN
 *      (history + same-day peers).
 *   3. EDP TARGET — the client's target for the EAN + the chain's canal.
 */

/** Tunables — same idea as the online panel, plus a longer window. */
export interface InStoreOutlierOptions {
  /** Flag when |deviation_pct| >= this (percent). Default 30. */
  threshold: number;
  /**
   * Days of prior in-store history feeding the baseline. Default 90
   * (visits are ~twice a week, so 30 days is often only 1–2 points).
   */
  windowDays: number;
  /** Min prior points before a baseline is trusted. Default 1. */
  minHistory: number;
}

export const DEFAULT_INSTORE_OUTLIER_OPTIONS: InStoreOutlierOptions = {
  threshold: 30,
  windowDays: 90,
  minHistory: 1,
};

export type InStoreOutlierSource = 'self-history' | 'cross-store' | 'target';
export type InStoreOutlierField = 'price' | 'wholesale_price';

/** One flagged field on one entry, for the review panel. */
export interface InStorePriceOutlier {
  entry_id: string;
  visit_id: string | null;
  ean: string;
  name: string;
  brand: string | null;
  supermarket_id: string;
  supermarket_name: string | null;
  entered_by: string;
  /** Which typed field is off. */
  field: InStoreOutlierField;
  /** The typed value that failed the check. */
  price: number;
  baseline: number;
  /** Signed % deviation (negative = drop, positive = spike). */
  deviation_pct: number;
  source: InStoreOutlierSource;
  review_status: string;
  created_at: string;
}

/** A priced field on a candidate entry, used by the pure detector. */
export interface InStoreOutlierItem {
  entryId: string;
  visitId: string | null;
  ean: string;
  name: string;
  brand: string | null;
  supermarketId: string;
  supermarketName: string | null;
  enteredBy: string;
  field: InStoreOutlierField;
  price: number;
  reviewStatus: string;
  createdAt: string;
}

/**
 * Map a supermarket canal to the price_targets code (same rules as
 * `targetCanalFor` in src/shared/priceAnomaly.ts). Duplicated here so
 * this module stays importable without the DB client.
 */
function targetCanalFor(canal: string | null | undefined): string | null {
  const c = (canal ?? '').trim().toUpperCase();
  if (c.startsWith('SPM')) return 'SPM';
  if (c === 'MAY REGIONAL') return 'MAY REG';
  if (c.startsWith('MAY')) return 'MAY';
  return null;
}

function median(nums: number[]): number {
  if (nums.length === 0) return NaN;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** History map key: one store's prior prices for one EAN + field. */
export function storeEanKey(store: string, ean: string, field: InStoreOutlierField): string {
  return `${store}|${ean}|${field}`;
}

/** History map key: all stores' prior prices for one EAN + field. */
export function eanFieldKey(ean: string, field: InStoreOutlierField): string {
  return `${ean}|${field}`;
}

/**
 * Flag typed prices among `items` that deviate ≥threshold% from a
 * baseline. First source with ≥minHistory points (or a target) wins.
 *
 * `histByStoreEan` is prior in-store prices keyed by store|ean|field.
 * `histByEan` is the same prices keyed only by ean|field (all stores),
 * used as the cross-store fallback. `targetsByEanCanal` is EDP targets
 * keyed by `ean|SPM` / `ean|MAY` / `ean|MAY REG`. `canalByStore` maps
 * supermarket id → full canal string.
 */
export function detectInStoreOutliers(
  items: InStoreOutlierItem[],
  histByStoreEan: Map<string, number[]>,
  histByEan: Map<string, number[]>,
  targetsByEanCanal: Map<string, number>,
  canalByStore: Map<string, string>,
  options: InStoreOutlierOptions = DEFAULT_INSTORE_OUTLIER_OPTIONS,
): InStorePriceOutlier[] {
  // Same-day peers (other stores) so a first visit can still be judged
  // against today's other PDVs for the same EAN.
  const todayByEan = new Map<string, InStoreOutlierItem[]>();
  for (const it of items) {
    const k = eanFieldKey(it.ean, it.field);
    const arr = todayByEan.get(k) ?? [];
    arr.push(it);
    todayByEan.set(k, arr);
  }

  const flags: InStorePriceOutlier[] = [];
  for (const it of items) {
    if (it.price <= 0) continue;

    const selfHist = histByStoreEan.get(storeEanKey(it.supermarketId, it.ean, it.field)) ?? [];
    const crossHist = histByEan.get(eanFieldKey(it.ean, it.field)) ?? [];
    const todayPeers = (todayByEan.get(eanFieldKey(it.ean, it.field)) ?? [])
      .filter((p) => p.entryId !== it.entryId && p.supermarketId !== it.supermarketId)
      .map((p) => p.price);
    const crossAll = [...crossHist, ...todayPeers];

    let baseline = NaN;
    let source: InStoreOutlierSource = 'self-history';

    if (selfHist.length >= options.minHistory) {
      baseline = median(selfHist);
      source = 'self-history';
    } else if (crossAll.length >= options.minHistory) {
      baseline = median(crossAll);
      source = 'cross-store';
    } else {
      const canal = canalByStore.get(it.supermarketId) ?? '';
      const targetCanal = targetCanalFor(canal);
      const target = targetCanal
        ? targetsByEanCanal.get(`${it.ean}|${targetCanal}`)
        : undefined;
      if (target && target > 0) {
        baseline = target;
        source = 'target';
      } else {
        continue;
      }
    }

    if (!Number.isFinite(baseline) || baseline <= 0) continue;

    const deviationPct = ((it.price - baseline) / baseline) * 100;
    if (Math.abs(deviationPct) < options.threshold) continue;

    flags.push({
      entry_id: it.entryId,
      visit_id: it.visitId,
      ean: it.ean,
      name: it.name,
      brand: it.brand,
      supermarket_id: it.supermarketId,
      supermarket_name: it.supermarketName,
      entered_by: it.enteredBy,
      field: it.field,
      price: it.price,
      baseline: Number(baseline.toFixed(2)),
      deviation_pct: Number(deviationPct.toFixed(1)),
      source,
      review_status: it.reviewStatus,
      created_at: it.createdAt,
    });
  }

  flags.sort((a, b) => Math.abs(b.deviation_pct) - Math.abs(a.deviation_pct));
  return flags;
}
