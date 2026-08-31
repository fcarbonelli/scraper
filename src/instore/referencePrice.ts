/**
 * Reference market price per EAN — powers the field app's typo warning.
 *
 * When a field worker types a price, the app warns if it deviates ±35% from the
 * product's recent MARKET price. That market data normally lives behind the
 * pricing endpoints, which the in-store API key can't reach — so we surface a
 * `reference_price` on the in-store lookup/catalog responses instead.
 *
 * The reference is resolved per EAN from the first source that has a signal:
 *   1. ONLINE market — median of the latest online price at each store over the
 *      last `onlineWindowDays` (DB-side via the `instore_market_reference` RPC,
 *      migration 027). This is the richest, freshest "market price".
 *   2. IN-STORE history — median of recent in-store entries for the EAN over the
 *      last `instoreWindowDays`. Covers wholesale-only items never scraped online.
 *   3. EDP TARGET — the client's price-list target (price_targets.edp), preferring
 *      SPM, then MAY, then MAY REG. A stable last resort so brand-new catalog
 *      items still get a sane reference.
 * EANs with no signal in any source map to `null` (the front just won't warn).
 */

import { db } from '../shared/db.js';
import { logger } from '../shared/logger.js';

export interface ReferencePriceOptions {
  /** Window for the online market median (days). Default 30. */
  onlineWindowDays: number;
  /** Window for the in-store history median (days). Default 90 — visits are sparse. */
  instoreWindowDays: number;
}

export const DEFAULT_REFERENCE_PRICE_OPTIONS: ReferencePriceOptions = {
  onlineWindowDays: 30,
  instoreWindowDays: 90,
};

// EAN `.in()` chunk size — keep the PostgREST URL under its length limit.
const CHUNK = 150;

function median(nums: number[]): number {
  if (nums.length === 0) return NaN;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

interface MarketRefRow {
  ean: string | null;
  reference_price: number | string | null;
}

/**
 * Online market medians via the DB RPC (migration 027). Degrades gracefully to
 * an empty map if the function isn't present yet (e.g. migration not applied),
 * so the endpoint still works off the in-store/target fallbacks.
 */
async function loadOnlineMedians(eans: string[], sinceIso: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const { data, error } = await db.rpc('instore_market_reference', {
      p_eans: eans,
      p_since: sinceIso,
    });
    if (error) throw error;
    for (const r of (data ?? []) as MarketRefRow[]) {
      const price = r.reference_price == null ? NaN : Number(r.reference_price);
      if (r.ean && Number.isFinite(price) && price > 0) out.set(r.ean, price);
    }
  } catch (err) {
    logger.warn(
      { err },
      'instore reference: instore_market_reference RPC unavailable — falling back to in-store/target only',
    );
  }
  return out;
}

/** Median of recent in-store entry prices per EAN (wholesale-only fallback). */
async function loadInStoreMedians(eans: string[], sinceIso: string): Promise<Map<string, number>> {
  const byEan = new Map<string, number[]>();
  for (let i = 0; i < eans.length; i += CHUNK) {
    const chunk = eans.slice(i, i + CHUNK);
    const { data, error } = await db
      .from('instore_price_entries')
      .select('ean, price')
      .in('ean', chunk)
      .gte('created_at', sinceIso)
      .neq('review_status', 'rejected')
      .eq('no_price', false)
      .gt('price', 0);
    if (error) throw error;
    for (const r of (data ?? []) as { ean: string; price: number | null }[]) {
      if (r.price == null || r.price <= 0) continue;
      const arr = byEan.get(r.ean) ?? [];
      arr.push(r.price);
      byEan.set(r.ean, arr);
    }
  }
  const out = new Map<string, number>();
  for (const [ean, prices] of byEan) {
    const m = median(prices);
    if (Number.isFinite(m) && m > 0) out.set(ean, Number(m.toFixed(2)));
  }
  return out;
}

/** EDP target per EAN, preferring SPM → MAY → MAY REG (final fallback). */
async function loadTargets(eans: string[]): Promise<Map<string, number>> {
  const byEanCanal = new Map<string, Map<string, number>>();
  for (let i = 0; i < eans.length; i += CHUNK) {
    const chunk = eans.slice(i, i + CHUNK);
    const { data, error } = await db
      .from('price_targets')
      .select('ean, canal, edp')
      .in('ean', chunk);
    if (error) throw error;
    for (const r of (data ?? []) as { ean: string | null; canal: string | null; edp: number | null }[]) {
      if (!r.ean || !r.canal || r.edp == null || r.edp <= 0) continue;
      const m = byEanCanal.get(r.ean) ?? new Map<string, number>();
      m.set(r.canal.trim().toUpperCase(), r.edp);
      byEanCanal.set(r.ean, m);
    }
  }
  const out = new Map<string, number>();
  for (const [ean, canals] of byEanCanal) {
    const edp = canals.get('SPM') ?? canals.get('MAY') ?? canals.get('MAY REG');
    if (edp != null && edp > 0) out.set(ean, edp);
  }
  return out;
}

/**
 * Resolve a reference market price for each EAN, applying the source priority
 * (online → in-store → target). Returns a Map; absent EANs have no reference.
 * The three sources are loaded in parallel (in-store/target tables are small),
 * then merged by priority.
 */
export async function loadReferencePrices(
  eans: string[],
  opts: Partial<ReferencePriceOptions> = {},
): Promise<Map<string, number>> {
  const options = { ...DEFAULT_REFERENCE_PRICE_OPTIONS, ...opts };
  const uniq = [...new Set(eans.filter((e): e is string => typeof e === 'string' && e.length > 0))];
  if (uniq.length === 0) return new Map();

  const now = Date.now();
  const onlineSince = new Date(now - options.onlineWindowDays * 86_400_000).toISOString();
  const instoreSince = new Date(now - options.instoreWindowDays * 86_400_000).toISOString();

  const [online, instore, targets] = await Promise.all([
    loadOnlineMedians(uniq, onlineSince),
    loadInStoreMedians(uniq, instoreSince),
    loadTargets(uniq),
  ]);

  const out = new Map<string, number>();
  for (const ean of uniq) {
    const ref = online.get(ean) ?? instore.get(ean) ?? targets.get(ean);
    if (ref != null && ref > 0) out.set(ean, ref);
  }
  return out;
}
