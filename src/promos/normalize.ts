/**
 * Pure normalization helpers shared by providers (no DB, no network — unit
 * testable). Maps provider-specific payloads onto the shared taxonomy used by
 * `NormalizedPromotion`.
 */

/** Naranja X / taxonomy weekday ids (1 = Lunes … 7 = Domingo) → canonical keys. */
const WEEKDAY_KEY_BY_ID: Record<number, string> = {
  1: 'MONDAY',
  2: 'TUESDAY',
  3: 'WEDNESDAY',
  4: 'THURSDAY',
  5: 'FRIDAY',
  6: 'SATURDAY',
  7: 'SUNDAY',
};

/**
 * Normalize a payment-method token to a taxonomy key. Sources use lowercase
 * ('credito', 'debito', 'dinero'); the taxonomy keys are uppercase
 * (CREDITO/DEBITO/DINERO/VISA/MASTER/AMEX). Unknown tokens pass through
 * uppercased so nothing is silently dropped.
 */
export function normalizePaymentMethod(raw: string): string {
  return String(raw ?? '').trim().toUpperCase();
}

export function normalizePaymentMethods(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out = new Set<string>();
  for (const v of list) {
    const key = normalizePaymentMethod(String(v));
    if (key) out.add(key);
  }
  return [...out];
}

/**
 * Map an array of weekday ids to canonical keys. A full week (all 7) collapses
 * to the sentinel ['ALL_DAYS'] to match the taxonomy's "Todos los días".
 */
export function weekdaysFromApplied(applied: unknown): string[] {
  if (!Array.isArray(applied) || applied.length === 0) return [];
  const ids = applied
    .map((n) => Number(n))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 7);
  const uniq = [...new Set(ids)];
  if (uniq.length >= 7) return ['ALL_DAYS'];
  return uniq.sort((a, b) => a - b).map((id) => WEEKDAY_KEY_BY_ID[id]!).filter(Boolean);
}

/**
 * Parse an Argentine "dd/MM/yyyy" date into an ISO string anchored to
 * Buenos Aires (UTC-3). Returns null on anything unparseable.
 */
export function parseArDate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const m = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const day = dd!.padStart(2, '0');
  const month = mm!.padStart(2, '0');
  // Anchor to -03:00 (America/Argentina/Buenos_Aires) so the calendar day is stable.
  const iso = `${yyyy}-${month}-${day}T00:00:00-03:00`;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** Extract a discount percentage from a promo title (e.g. "25% off" → 25). */
export function parseDiscountPct(title: unknown): number | null {
  if (typeof title !== 'string') return null;
  const m = title.match(/(\d{1,3})\s*%/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : null;
}

/** Extract a number of installments from a promo title (e.g. "12 cuotas" → 12). */
export function parseInstallments(title: unknown): number | null {
  if (typeof title !== 'string') return null;
  const m = title.match(/(\d{1,2})\s*cuotas?/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Earliest non-null ISO date from a list (for valid_from). */
export function minIso(dates: Array<string | null>): string | null {
  const ts = dates.filter((d): d is string => !!d).map((d) => Date.parse(d));
  if (ts.length === 0) return null;
  return new Date(Math.min(...ts)).toISOString();
}

/** Latest non-null ISO date from a list (for valid_to). */
export function maxIso(dates: Array<string | null>): string | null {
  const ts = dates.filter((d): d is string => !!d).map((d) => Date.parse(d));
  if (ts.length === 0) return null;
  return new Date(Math.max(...ts)).toISOString();
}
