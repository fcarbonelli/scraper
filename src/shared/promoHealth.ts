/**
 * Promo-health check for the daily-review publicación panel.
 *
 * Pure aggregation, no database. The loader lives in `promoHealthQuery.ts`.
 *
 * For each supermarket priced in the run, compare today's share of rows that
 * carry an offer with that chain's own previous days. A row is on offer when
 * `list_price > price` or `promotions` is non-empty — the same rule the
 * Resumen uses. The panel flags a chain that usually has offers and today has
 * none, or far fewer, so an operator can spot a site whose promo markup
 * stopped being read while prices still come in.
 *
 * Chains that rarely promote stay quiet: a baseline below
 * `minBaselineSharePct` is not judged. Days with fewer than `minPriced`
 * priced rows are ignored, so a partial scrape is not read as a promo failure.
 */

export interface PromoHealthOptions {
  /** Prior days that feed the baseline, excluding the run's day. Default 7. */
  windowDays: number;
  /** Flag when today's share falls by at least this percent of the baseline. Default 50. */
  dropThresholdPct: number;
  /** Baseline share below this (percent) is not treated as a promo chain. Default 5. */
  minBaselineSharePct: number;
  /** Priced rows a day needs before it counts. Default 10. */
  minPriced: number;
  /** Baseline days required before a chain is judged. Default 3. */
  minDays: number;
}

export const DEFAULT_PROMO_HEALTH_OPTIONS: PromoHealthOptions = {
  windowDays: 7,
  dropThresholdPct: 50,
  minBaselineSharePct: 5,
  minPriced: 10,
  minDays: 3,
};

/** Why a chain was flagged. Zero offers today wins over a plain drop. */
export type PromoHealthReason = 'none_today' | 'sharp_drop';

/** One priced snapshot, today or on a prior day. */
export interface PromoObservation {
  supermarketProductId: string;
  supermarketId: string;
  supermarketName: string;
  /** ISO timestamp. */
  scrapedAt: string;
  price: number;
  listPrice: number | null;
  promotions: unknown;
}

/** One chain the operator should look at before publishing. */
export interface PromoHealthChain {
  supermarket_id: string;
  name: string;
  priced_today: number;
  promoted_today: number;
  /** Share of today's priced rows that carry an offer, percent. */
  share_today_pct: number;
  /** Pooled share over baseline days that had enough priced rows, percent. */
  share_baseline_pct: number;
  /** Baseline days that cleared `minPriced`. */
  days_observed: number;
  /**
   * Relative drop of today's share against the baseline, percent.
   * 100 means the offers disappeared. Negative means more offers than usual.
   */
  drop_pct: number;
  reason: PromoHealthReason;
}

export interface PromoHealthVerdict {
  /** Chains with enough priced rows today and a usable promo baseline. */
  evaluated: number;
  /** Flagged chains: zeros first, then the steepest drop. */
  chains: PromoHealthChain[];
}

/** UTC half-open window [date − windowDays, date) for the baseline query. */
export function baselineBounds(
  date: string,
  windowDays: number,
): { startIso: string; endIso: string; startMs: number; endMs: number } {
  const endMs = Date.parse(`${date}T00:00:00.000Z`);
  const startMs = endMs - windowDays * 86_400_000;
  return {
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(endMs).toISOString(),
    startMs,
    endMs,
  };
}

/**
 * A row is on offer when the shelf price is below the list price, or the
 * snapshot stored at least one promotion.
 */
export function isOnPromo(row: {
  price: number;
  listPrice: number | null;
  promotions: unknown;
}): boolean {
  if (row.listPrice != null && row.listPrice > row.price) return true;
  return Array.isArray(row.promotions) && row.promotions.length > 0;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Keep the latest snapshot for each key. A later `scrapedAt` wins. */
function latestBy(
  rows: PromoObservation[],
  keyOf: (row: PromoObservation) => string,
): PromoObservation[] {
  const best = new Map<string, PromoObservation>();
  for (const row of rows) {
    const key = keyOf(row);
    const prev = best.get(key);
    if (!prev || row.scrapedAt > prev.scrapedAt) best.set(key, row);
  }
  return [...best.values()];
}

interface DayTally {
  priced: number;
  promoted: number;
}

/**
 * Judge each chain present in `today` against its own baseline.
 *
 * History is attributed through the mapping priced today, so the comparison
 * is the same basket. Rows outside the window, and a second snapshot of the
 * same mapping on the same UTC day, are dropped here.
 */
export function judgePromoHealth(
  date: string,
  today: PromoObservation[],
  history: PromoObservation[],
  opts: Partial<PromoHealthOptions> = {},
): PromoHealthVerdict {
  const options: PromoHealthOptions = { ...DEFAULT_PROMO_HEALTH_OPTIONS, ...opts };
  const bounds = baselineBounds(date, options.windowDays);

  const todayRows = latestBy(today, (row) => row.supermarketProductId);
  const byChain = new Map<string, { name: string; rows: PromoObservation[] }>();
  const chainByMapping = new Map<string, string>();
  for (const row of todayRows) {
    chainByMapping.set(row.supermarketProductId, row.supermarketId);
    const chain = byChain.get(row.supermarketId);
    if (chain) chain.rows.push(row);
    else {
      byChain.set(row.supermarketId, {
        name: row.supermarketName || row.supermarketId,
        rows: [row],
      });
    }
  }

  const historyRows = latestBy(
    history.filter((row) => {
      const t = Date.parse(row.scrapedAt);
      return Number.isFinite(t) && t >= bounds.startMs && t < bounds.endMs;
    }),
    (row) =>
      `${row.supermarketProductId}|${new Date(Date.parse(row.scrapedAt)).toISOString().slice(0, 10)}`,
  );

  const historyByChain = new Map<string, Map<string, DayTally>>();
  for (const row of historyRows) {
    const supermarketId = chainByMapping.get(row.supermarketProductId);
    if (!supermarketId) continue;
    const day = new Date(Date.parse(row.scrapedAt)).toISOString().slice(0, 10);
    let days = historyByChain.get(supermarketId);
    if (!days) {
      days = new Map();
      historyByChain.set(supermarketId, days);
    }
    const tally = days.get(day) ?? { priced: 0, promoted: 0 };
    tally.priced += 1;
    if (isOnPromo(row)) tally.promoted += 1;
    days.set(day, tally);
  }

  let evaluated = 0;
  const chains: PromoHealthChain[] = [];

  for (const [supermarketId, chain] of byChain) {
    if (chain.rows.length < options.minPriced) continue;

    let baselinePriced = 0;
    let baselinePromoted = 0;
    let daysObserved = 0;
    const days = historyByChain.get(supermarketId);
    if (days) {
      for (const tally of days.values()) {
        if (tally.priced < options.minPriced) continue;
        daysObserved += 1;
        baselinePriced += tally.priced;
        baselinePromoted += tally.promoted;
      }
    }
    if (daysObserved < options.minDays || baselinePriced <= 0) continue;

    const shareBaseline = (baselinePromoted / baselinePriced) * 100;
    if (shareBaseline < options.minBaselineSharePct) continue;

    evaluated += 1;

    let promotedToday = 0;
    for (const row of chain.rows) {
      if (isOnPromo(row)) promotedToday += 1;
    }
    const shareToday = (promotedToday / chain.rows.length) * 100;
    const dropPct = ((shareBaseline - shareToday) / shareBaseline) * 100;
    const noneToday = promotedToday === 0;
    if (!noneToday && dropPct < options.dropThresholdPct) continue;

    chains.push({
      supermarket_id: supermarketId,
      name: chain.name,
      priced_today: chain.rows.length,
      promoted_today: promotedToday,
      share_today_pct: round1(shareToday),
      share_baseline_pct: round1(shareBaseline),
      days_observed: daysObserved,
      drop_pct: round1(dropPct),
      reason: noneToday ? 'none_today' : 'sharp_drop',
    });
  }

  chains.sort((a, b) => {
    if (a.reason !== b.reason) return a.reason === 'none_today' ? -1 : 1;
    if (b.drop_pct !== a.drop_pct) return b.drop_pct - a.drop_pct;
    return a.name.localeCompare(b.name);
  });

  return { evaluated, chains };
}
