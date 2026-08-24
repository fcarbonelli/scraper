/**
 * Price-outlier detection for the in-store review tab.
 *
 * Goal: surface typed prices that deviate ≥threshold% from a baseline so
 * an operator can catch field-worker typos (extra zero, missing zero)
 * BEFORE approving a visit — the same "precios desviados" panel the
 * online publicación view already has.
 *
 * Pure detection lives in `detectOutliers.ts` (no DB). This file loads
 * the day's entries + history + targets and calls it.
 */

import { db, fetchAllPages } from '../shared/db.js';
import { baDayRangeUtc } from './dates.js';
import {
  DEFAULT_INSTORE_OUTLIER_OPTIONS,
  detectInStoreOutliers,
  eanFieldKey,
  storeEanKey,
  type InStoreOutlierItem,
  type InStoreOutlierOptions,
  type InStorePriceOutlier,
} from './detectOutliers.js';

export {
  DEFAULT_INSTORE_OUTLIER_OPTIONS,
  detectInStoreOutliers,
  type InStoreOutlierField,
  type InStoreOutlierItem,
  type InStoreOutlierOptions,
  type InStoreOutlierSource,
  type InStorePriceOutlier,
} from './detectOutliers.js';

export interface InStorePriceOutliersResult {
  date: string;
  supermarket_id: string | null;
  baseline: {
    method: 'self-history-then-cross-store-then-target';
    windowDays: number;
    minHistory: number;
  };
  threshold: number;
  count: number;
  priceOutliers: InStorePriceOutlier[];
}

// -----------------------------------------------------------------------------
// Loaders
// -----------------------------------------------------------------------------

interface EntryRow {
  id: string;
  visit_id: string | null;
  supermarket_id: string;
  ean: string;
  product_name: string | null;
  price: number | null;
  no_price: boolean;
  promo_price: number | null;
  entered_by: string;
  review_status: string;
  created_at: string;
  products: { name: string | null; brand: string | null } | { name: string | null; brand: string | null }[] | null;
  supermarkets: { name: string; cadena_display_name: string | null } | { name: string; cadena_display_name: string | null }[] | null;
}

function firstJoin<T>(v: T | T[] | null | undefined): T | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

/** Turn a DB entry into 0–2 priced items (regular and/or wholesale). */
function itemsFromEntry(r: EntryRow): InStoreOutlierItem[] {
  if (r.no_price || r.review_status === 'rejected') return [];
  const product = firstJoin(r.products);
  const store = firstJoin(r.supermarkets);
  const name = product?.name ?? r.product_name ?? '';
  const brand = product?.brand ?? null;
  const supermarketName = store?.cadena_display_name ?? store?.name ?? null;
  const base = {
    entryId: r.id,
    visitId: r.visit_id,
    ean: r.ean,
    name,
    brand,
    supermarketId: r.supermarket_id,
    supermarketName,
    enteredBy: r.entered_by,
    reviewStatus: r.review_status,
    createdAt: r.created_at,
  };
  const out: InStoreOutlierItem[] = [];
  if (r.price != null && r.price > 0) {
    out.push({ ...base, field: 'price', price: r.price });
  }
  if (r.promo_price != null && r.promo_price > 0) {
    out.push({ ...base, field: 'wholesale_price', price: r.promo_price });
  }
  return out;
}

async function loadDayEntries(
  date: string,
  supermarketId?: string,
): Promise<EntryRow[]> {
  const { fromUtc, toUtc } = baDayRangeUtc(date);
  return fetchAllPages<EntryRow>((from, to) => {
    let query = db
      .from('instore_price_entries')
      .select(
        'id, visit_id, supermarket_id, ean, product_name, price, no_price, promo_price, entered_by, review_status, created_at, products(name, brand), supermarkets(name, cadena_display_name)',
      )
      .gte('created_at', fromUtc)
      .lt('created_at', toUtc)
      .neq('review_status', 'rejected')
      .order('created_at', { ascending: true })
      .range(from, to);
    if (supermarketId) query = query.eq('supermarket_id', supermarketId);
    return query;
  });
}

/**
 * Prior in-store prices in [date - windowDays, date), keyed two ways:
 * per store+EAN (self-history) and per EAN (cross-store).
 */
async function loadHistory(
  eans: string[],
  date: string,
  windowDays: number,
): Promise<{ byStoreEan: Map<string, number[]>; byEan: Map<string, number[]> }> {
  const byStoreEan = new Map<string, number[]>();
  const byEan = new Map<string, number[]>();
  if (eans.length === 0) return { byStoreEan, byEan };

  const { fromUtc: dayStart } = baDayRangeUtc(date);
  const histStart = new Date(
    new Date(dayStart).getTime() - windowDays * 86_400_000,
  ).toISOString();

  // Chunk EANs so the `.in()` URL stays under PostgREST's length limit.
  const CHUNK = 150;
  for (let i = 0; i < eans.length; i += CHUNK) {
    const chunk = eans.slice(i, i + CHUNK);
    const rows = await fetchAllPages<{
      supermarket_id: string;
      ean: string;
      price: number | null;
      promo_price: number | null;
      no_price: boolean;
      review_status: string;
    }>((from, to) =>
      db
        .from('instore_price_entries')
        .select('supermarket_id, ean, price, promo_price, no_price, review_status')
        .in('ean', chunk)
        .gte('created_at', histStart)
        .lt('created_at', dayStart)
        .neq('review_status', 'rejected')
        .eq('no_price', false)
        .order('created_at', { ascending: true })
        .range(from, to),
    );

    for (const h of rows) {
      if (h.price != null && h.price > 0) {
        const sk = storeEanKey(h.supermarket_id, h.ean, 'price');
        const ek = eanFieldKey(h.ean, 'price');
        const sArr = byStoreEan.get(sk) ?? [];
        sArr.push(h.price);
        byStoreEan.set(sk, sArr);
        const eArr = byEan.get(ek) ?? [];
        eArr.push(h.price);
        byEan.set(ek, eArr);
      }
      if (h.promo_price != null && h.promo_price > 0) {
        const sk = storeEanKey(h.supermarket_id, h.ean, 'wholesale_price');
        const ek = eanFieldKey(h.ean, 'wholesale_price');
        const sArr = byStoreEan.get(sk) ?? [];
        sArr.push(h.promo_price);
        byStoreEan.set(sk, sArr);
        const eArr = byEan.get(ek) ?? [];
        eArr.push(h.promo_price);
        byEan.set(ek, eArr);
      }
    }
  }

  return { byStoreEan, byEan };
}

async function loadTargets(): Promise<Map<string, number>> {
  const rows = await fetchAllPages<{ ean: string | null; canal: string | null; edp: number | null }>(
    (from, to) =>
      db.from('price_targets').select('ean, canal, edp').order('ean', { ascending: true }).range(from, to),
  );
  const map = new Map<string, number>();
  for (const r of rows) {
    if (!r.ean || !r.canal || r.edp == null || r.edp <= 0) continue;
    map.set(`${r.ean}|${r.canal.trim().toUpperCase()}`, r.edp);
  }
  return map;
}

async function loadCanalByStore(): Promise<Map<string, string>> {
  const { data, error } = await db.from('supermarkets').select('id, canal');
  if (error) throw error;
  return new Map(
    (data ?? []).map((s) => [s.id as string, ((s.canal as string | null) ?? '').trim()]),
  );
}

/**
 * Compute ≥threshold outliers for one Buenos Aires day of in-store
 * entries. Reads pending + approved rows so the panel works before
 * (and after) visit approval.
 */
export async function computeInStorePriceOutliers(
  date: string,
  opts: Partial<InStoreOutlierOptions> & { supermarketId?: string } = {},
): Promise<InStorePriceOutliersResult> {
  const options: InStoreOutlierOptions = {
    ...DEFAULT_INSTORE_OUTLIER_OPTIONS,
    ...(opts.threshold !== undefined ? { threshold: opts.threshold } : {}),
    ...(opts.windowDays !== undefined ? { windowDays: opts.windowDays } : {}),
    ...(opts.minHistory !== undefined ? { minHistory: opts.minHistory } : {}),
  };
  const supermarketId = opts.supermarketId;

  const empty: InStorePriceOutliersResult = {
    date,
    supermarket_id: supermarketId ?? null,
    baseline: {
      method: 'self-history-then-cross-store-then-target',
      windowDays: options.windowDays,
      minHistory: options.minHistory,
    },
    threshold: options.threshold,
    count: 0,
    priceOutliers: [],
  };

  const dayRows = await loadDayEntries(date, supermarketId);
  const items = dayRows.flatMap(itemsFromEntry);
  if (items.length === 0) return empty;

  const eans = [...new Set(items.map((i) => i.ean))];
  const [history, targets, canalByStore] = await Promise.all([
    loadHistory(eans, date, options.windowDays),
    loadTargets(),
    loadCanalByStore(),
  ]);

  const flags = detectInStoreOutliers(
    items,
    history.byStoreEan,
    history.byEan,
    targets,
    canalByStore,
    options,
  );

  return { ...empty, count: flags.length, priceOutliers: flags };
}
