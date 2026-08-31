/**
 * Pure market-reference helpers (no DB).
 *
 * Split out of `referencePrice.ts` so unit tests can run without the
 * side-effecting Supabase client.
 */

/** One store's latest published price for an EAN. */
export interface StorePrice {
  cadena: string;
  canal: string;
  price: number;
  date: string;
}

export function median(nums: number[]): number {
  if (nums.length === 0) return NaN;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Same family collapse as `canalFamily` in priceAnomaly — kept local so this file stays DB-free. */
function isMayCanal(canal: string): boolean {
  return canal.trim().toUpperCase().startsWith('MAY');
}

/**
 * Collapse daily rows to latest-per-chain, then take the MAY median
 * (or the all-channel median when no MAY prices exist).
 */
export function pickReferencePrice(rows: StorePrice[]): number | null {
  if (rows.length === 0) return null;

  const latest = new Map<string, StorePrice>();
  for (const r of rows) {
    if (!(r.price > 0)) continue;
    const prev = latest.get(r.cadena);
    if (!prev || r.date > prev.date) latest.set(r.cadena, r);
  }

  const may: number[] = [];
  const all: number[] = [];
  for (const r of latest.values()) {
    all.push(r.price);
    if (isMayCanal(r.canal)) may.push(r.price);
  }

  const pool = may.length > 0 ? may : all;
  const m = median(pool);
  if (!Number.isFinite(m) || m <= 0) return null;
  return Number(m.toFixed(2));
}
