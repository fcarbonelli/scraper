/**
 * Derived pricing indicators for the client base (export + /pricing API).
 *
 * Two client-defined columns, both computed at the application layer (they
 * depend on the hardcoded NUEVA_CATEGORIZACION map, which is NOT a column of the
 * client_base view) and formatted as a whole-number percentage string (e.g.
 * "23%", "-5%", "0%"), never a decimal:
 *
 *   DIFF_VS_EDP        — Precio_Regular vs the client's EDP target price.
 *                        round(Precio_Regular / (PRECIO_TGT_SPM | PRECIO_TGT_MAY) - 1) * 100.
 *                        Only one target is reported per row (channel-dependent);
 *                        we take whichever is present (SPM first). Blank when the
 *                        row has no price or no target.
 *
 *   IDX_VS_COMPETENCIA — a competitor's Precio_Regular vs the Ayudín equivalent's.
 *                        NUEVA_CATEGORIZACION codes end in "A" (Ayudín) or "A1"
 *                        (competitor); a competitor code maps to its Ayudín code
 *                        by dropping the trailing "1" (e.g. AERO_DESINF_332_A1 →
 *                        AERO_DESINF_332_A). For each competitor (A1) row we
 *                        divide by the Ayudín (A) row's price in the SAME
 *                        supermarket on the SAME date (first match when several
 *                        share the code). Only competitor rows get a value;
 *                        Ayudín rows stay blank.
 */

import { nuevaCategorizacionFor, NUEVA_CATEGORIZACION_BY_EAN } from './nuevaCategorizacion.js';

// -----------------------------------------------------------------------------
// Numeric parsing + formatting
// -----------------------------------------------------------------------------

/** Parse a view value (number | numeric string | null) to a finite number, else null. */
function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Format a ratio-minus-1 (e.g. 0.23) as a whole-number percentage string ("23%"). */
function pct(ratioMinusOne: number): string {
  // `+ 0` normalizes -0 to 0 so we never emit "-0%".
  return `${Math.round(ratioMinusOne * 100) + 0}%`;
}

// -----------------------------------------------------------------------------
// DIFF_VS_EDP (per-row)
// -----------------------------------------------------------------------------

/**
 * DIFF_VS_EDP for a client_base row. `precioRegular` is the row's Precio_Regular;
 * `tgtSpm`/`tgtMay` are PRECIO_TGT_SPM / PRECIO_TGT_MAY (only one is set per row).
 * Returns "" when there's no price or no (positive) target to compare against.
 */
export function diffVsEdp(precioRegular: unknown, tgtSpm: unknown, tgtMay: unknown): string {
  const pr = toNumber(precioRegular);
  const tgt = toNumber(tgtSpm) ?? toNumber(tgtMay);
  if (pr === null || tgt === null || tgt <= 0) return '';
  return pct(pr / tgt - 1);
}

// -----------------------------------------------------------------------------
// IDX_VS_COMPETENCIA (cross-row: competitor vs Ayudín)
// -----------------------------------------------------------------------------

/** Ayudín reference key: `${nuevaCategorizacionCode}|${cadena}|${fechaRelevamiento}`. */
function refKey(code: string, cadena: unknown, fecha: unknown): string {
  return `${code}|${String(cadena ?? '')}|${String(fecha ?? '')}`;
}

/**
 * Build the Ayudín price reference from a set of client_base rows: for every
 * Ayudín row (NUEVA_CATEGORIZACION ends in "A", not "A1") with a usable price,
 * remember the FIRST Precio_Regular seen per (code, supermarket, date). Rows are
 * consumed in the order given, so callers control which "first" wins.
 */
export function buildAyudinPriceRef(rows: Array<Record<string, unknown>>): Map<string, number> {
  const ref = new Map<string, number>();
  for (const row of rows) {
    const code = nuevaCategorizacionFor(String(row['EAN'] ?? ''));
    if (!code || !code.endsWith('A') || code.endsWith('A1')) continue;
    const price = toNumber(row['Precio_Regular']);
    if (price === null || price <= 0) continue;
    const key = refKey(code, row['Cadena'], row['Fecha_Relevamiento']);
    if (!ref.has(key)) ref.set(key, price);
  }
  return ref;
}

/** True when this EAN's NUEVA_CATEGORIZACION marks it as a competitor (ends in "A1"). */
export function isCompetitorEan(ean: string): boolean {
  return nuevaCategorizacionFor(ean).endsWith('A1');
}

/** The distinct set of Ayudín EANs (NUEVA_CATEGORIZACION ends in "A"), for reference queries. */
export function ayudinEans(): string[] {
  const out: string[] = [];
  for (const [ean, code] of NUEVA_CATEGORIZACION_BY_EAN) {
    if (code.endsWith('A') && !code.endsWith('A1')) out.push(ean);
  }
  return out;
}

/**
 * IDX_VS_COMPETENCIA for a single competitor row, using a prebuilt Ayudín ref.
 * Returns "" for non-competitor rows, rows without a price, or when no matching
 * Ayudín price exists in the same supermarket/date.
 */
export function idxVsCompetencia(
  row: Record<string, unknown>,
  ref: Map<string, number>,
): string {
  const code = nuevaCategorizacionFor(String(row['EAN'] ?? ''));
  if (!code.endsWith('A1')) return '';
  const price = toNumber(row['Precio_Regular']);
  if (price === null || price <= 0) return '';
  const ayudinCode = code.slice(0, -1); // "…A1" -> "…A"
  const ayudinPrice = ref.get(refKey(ayudinCode, row['Cadena'], row['Fecha_Relevamiento']));
  if (ayudinPrice === undefined || ayudinPrice <= 0) return '';
  return pct(price / ayudinPrice - 1);
}
