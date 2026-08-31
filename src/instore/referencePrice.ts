/**
 * Market reference price for the in-store typo warning.
 *
 * The field app is scoped to `/v1/in-store/*` so it can't call /pricing.
 * Lookup + catalog attach `reference_price` (median of recent market
 * prices for the EAN) and the frontend warns when the typed value is
 * ±35% off that number.
 *
 * In-store chains are mayorista, so we prefer the MAY-channel median
 * (latest Precio_Regular per chain over the last N days). Falling back
 * to all channels only when there is no wholesale history — mixing SPM
 * list prices in as the primary baseline would flag every legit
 * wholesale entry as "too cheap".
 *
 * Reads `client_base` (published only) so a pending typo from today
 * can't pollute the number we're comparing against.
 *
 * Pure pick/median are exported for unit tests.
 */

import { db, fetchAllPages } from '../shared/db.js';
import { todayInBuenosAires } from './dates.js';
import { pickReferencePrice, type StorePrice } from './referencePriceCore.js';

export { median, pickReferencePrice, type StorePrice } from './referencePriceCore.js';

/** How many BA days of published prices feed the median. */
export const REFERENCE_WINDOW_DAYS = 30;

/** Process-level cache so catalog refresh doesn't re-query every open. */
const CACHE_TTL_MS = 15 * 60 * 1000;

interface CacheEntry {
  loadedAt: number;
  byEan: Map<string, number>;
}

let cache: CacheEntry | null = null;

interface ClientBasePriceRow {
  EAN: string | null;
  Cadena: string | null;
  Canal: string | null;
  Precio_Regular: number | null;
  Fecha_Relevamiento: string | null;
}

function windowStartDate(): string {
  const today = todayInBuenosAires();
  const [y, m, d] = today.split('-').map(Number);
  const start = new Date(Date.UTC(y ?? 2026, (m ?? 1) - 1, (d ?? 1) - REFERENCE_WINDOW_DAYS));
  return start.toISOString().slice(0, 10);
}

/**
 * Load published prices for `eans` and return a median per EAN.
 * Empty / unknown EANs are omitted (caller treats missing as null).
 */
export async function loadReferencePrices(eans: string[]): Promise<Map<string, number>> {
  const unique = [...new Set(eans.filter((e) => e.length > 0))];
  const out = new Map<string, number>();
  if (unique.length === 0) return out;

  const now = Date.now();
  if (cache && now - cache.loadedAt < CACHE_TTL_MS) {
    for (const ean of unique) {
      const v = cache.byEan.get(ean);
      if (v != null) out.set(ean, v);
    }
    // Cache hit only if every requested EAN was present OR we loaded the
    // full catalog last time (cache covers all published EANs).
    if (out.size === unique.length || cache.byEan.size > unique.length) {
      return out;
    }
  }

  const from = windowStartDate();
  const byEanRows = new Map<string, StorePrice[]>();
  const CHUNK = 150;

  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const rows = await fetchAllPages<ClientBasePriceRow>((fromIdx, toIdx) =>
      db
        .from('client_base')
        .select('EAN, Cadena, Canal, Precio_Regular, Fecha_Relevamiento')
        .in('EAN', chunk)
        .gte('Fecha_Relevamiento', from)
        .gt('Precio_Regular', 0)
        .order('Fecha_Relevamiento', { ascending: false })
        .range(fromIdx, toIdx),
    );

    for (const r of rows) {
      if (!r.EAN || r.Precio_Regular == null || r.Precio_Regular <= 0) continue;
      const arr = byEanRows.get(r.EAN) ?? [];
      arr.push({
        cadena: r.Cadena ?? '',
        canal: r.Canal ?? '',
        price: Number(r.Precio_Regular),
        date: String(r.Fecha_Relevamiento ?? '').slice(0, 10),
      });
      byEanRows.set(r.EAN, arr);
    }
  }

  const fresh = new Map<string, number>();
  for (const [ean, rows] of byEanRows) {
    const ref = pickReferencePrice(rows);
    if (ref != null) fresh.set(ean, ref);
  }

  cache = { loadedAt: now, byEan: fresh };
  return fresh;
}

/** Look up one EAN's reference price, or null when we have no market history. */
export async function referencePriceFor(ean: string): Promise<number | null> {
  const map = await loadReferencePrices([ean]);
  return map.get(ean) ?? null;
}

/** Test helper — drop the process cache between cases. */
export function resetReferencePriceCache(): void {
  cache = null;
}
