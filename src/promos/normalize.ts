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

/**
 * Parse an ISO calendar date ("yyyy-MM-dd") into an ISO string anchored to
 * Buenos Aires (UTC-3). Returns null on anything unparseable.
 */
export function parseYmdDate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const m = raw.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return null;
  const [, yyyy, mm, dd] = m;
  const iso = `${yyyy}-${mm!.padStart(2, '0')}-${dd!.padStart(2, '0')}T00:00:00-03:00`;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * Parse a Microsoft/ASP.NET JSON date ("/Date(1612148400000)/", epoch ms) into
 * an ISO string. Handles an optional trailing timezone offset. Returns null on
 * anything unparseable. Used by the Cuenta DNI provider.
 */
export function parseMsDate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const m = raw.match(/\/Date\((-?\d+)(?:[+-]\d{4})?\)\//);
  if (!m) return null;
  const ms = Number(m[1]);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Discount-context stems (accent-stripped). A percentage only counts as a
 * discount when one of these appears near it.
 */
const DISCOUNT_STEMS = [
  'descuento', 'desc.', 'dto', 'off', 'ahorr', 'reintegro', 'devolu',
  'bonific', 'cashback', 'menos', 'rebaja', 'gratis', 'sin cargo',
];

/**
 * If the text immediately AFTER the "%" starts with one of these, the number is
 * not a discount (e.g. "100% online", "100% digital", "100% del país").
 */
const NON_DISCOUNT_AFTER = /^\s*(online|digital|en\s*linea|del?\s*pais|nacional|seguro|natural)/;

/**
 * Context words (accent-stripped) that signal a NON-discount use of the number:
 * raffles, financing rates, price increases. If any appears near the match, skip.
 */
const CONTEXT_DISQUALIFIERS = [
  'sorteo', 'premio', 'financ', 'tna', 'tea', 'cft', 'aumento',
  'del capital', 'monto financiado', 'interes',
];

/**
 * Extract a discount percentage from free promo text (title/subtitle/rows).
 *
 * This is deliberately conservative because provider text blobs are noisy: a
 * bare `\d{1,3}%` match over-reports (raffles saying "ganá el 100%", the very
 * common "100% online", financing "TNA 100%", generic campaigns). We therefore:
 *   - ignore a "%" immediately followed by non-discount words ("100% online"),
 *   - drop matches sitting in a raffle/financing context,
 *   - and require an explicit discount keyword nearby for the extreme **100%**
 *     (a real 100%-off is rare and always worded as "100% de descuento/off/…").
 * Returns the largest qualifying discount, or null.
 */
export function parseDiscountPct(title: unknown): number | null {
  if (typeof title !== 'string' || title.trim() === '') return null;
  const t = deburr(title);
  let best: number | null = null;

  for (const m of t.matchAll(/(\d{1,3})\s*%/g)) {
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n <= 0 || n > 100) continue;

    const idx = m.index ?? 0;
    const afterStart = idx + m[0].length;
    // "50% online" / "100% digital" → the % qualifies the channel, not a discount.
    if (NON_DISCOUNT_AFTER.test(t.slice(afterStart, afterStart + 16))) continue;

    // A small window around the match to read its context.
    const window = t.slice(Math.max(0, idx - 26), afterStart + 22);
    if (CONTEXT_DISQUALIFIERS.some((w) => window.includes(w))) continue;

    if (n === 100 && !DISCOUNT_STEMS.some((w) => window.includes(w))) {
      // 100% with no discount word nearby is almost always a false positive
      // (raffle, "100% del país", generic). Require an explicit discount cue.
      continue;
    }

    best = best == null ? n : Math.max(best, n);
  }

  return best;
}

/** Extract a number of installments from a promo title (e.g. "12 cuotas" → 12). */
export function parseInstallments(title: unknown): number | null {
  if (typeof title !== 'string') return null;
  const m = title.match(/(\d{1,2})\s*cuotas?/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Spanish weekday letters used by MODO's `days_of_week` field
 * ("LMXJVSD" = every day) → canonical keys. Unambiguous in AR usage:
 * L=lunes, M=martes, X=miércoles, J=jueves, V=viernes, S=sábado, D=domingo.
 */
const WEEKDAY_KEY_BY_LETTER: Record<string, string> = {
  L: 'MONDAY',
  M: 'TUESDAY',
  X: 'WEDNESDAY',
  J: 'THURSDAY',
  V: 'FRIDAY',
  S: 'SATURDAY',
  D: 'SUNDAY',
};

/**
 * Parse a compact weekday-letters string ("LMXJVSD") into canonical keys.
 * A full week collapses to ['ALL_DAYS'] to match the taxonomy sentinel.
 */
export function weekdaysFromLetters(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  const keys = new Set<string>();
  for (const ch of raw.toUpperCase()) {
    const key = WEEKDAY_KEY_BY_LETTER[ch];
    if (key) keys.add(key);
  }
  if (keys.size >= 7) return ['ALL_DAYS'];
  return [...keys];
}

/**
 * Map MODO card-network lists (debit_list/credit_list, e.g. ['visa','cabal'])
 * onto normalized payment-method keys. Emits the generic CREDITO/DEBITO keys
 * (so coarse filters work) plus each specific network uppercased (VISA/MASTER/…).
 */
export function paymentMethodsFromCardLists(
  debitList: unknown,
  creditList: unknown,
): string[] {
  const out = new Set<string>();
  const debit = Array.isArray(debitList) ? debitList : [];
  const credit = Array.isArray(creditList) ? creditList : [];
  if (debit.length > 0) out.add('DEBITO');
  if (credit.length > 0) out.add('CREDITO');
  for (const v of [...debit, ...credit]) {
    const key = String(v ?? '').trim().toUpperCase();
    if (key) out.add(key);
  }
  return [...out];
}

/**
 * Map MODO's `payment_flow` ("instore,online,instore_nfc") onto ONLINE/IN_STORE
 * purchase modes (NFC counts as in-store).
 */
export function purchaseModesFromFlow(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  const out = new Set<string>();
  for (const token of raw.split(',')) {
    const t = token.trim().toLowerCase();
    if (t.startsWith('online')) out.add('ONLINE');
    else if (t.startsWith('instore')) out.add('IN_STORE');
  }
  return [...out];
}

/** Day-name → canonical key (accent-stripped, singular). */
const WEEKDAY_KEY_BY_NAME: Record<string, string> = {
  lunes: 'MONDAY',
  martes: 'TUESDAY',
  miercoles: 'WEDNESDAY',
  jueves: 'THURSDAY',
  viernes: 'FRIDAY',
  sabado: 'SATURDAY',
  domingo: 'SUNDAY',
};
const WEEKDAY_ORDER = [
  'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY',
];

/** Remove diacritics + lowercase, for robust Spanish text matching. */
function deburr(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/**
 * Parse a Spanish weekday "leyenda" (e.g. "Todos los días", "Lunes y martes",
 * "Lunes a viernes", "Sábados y domingos") into canonical keys. Handles single
 * days, "y"-joined lists, and "a"-joined ranges. A full week → ['ALL_DAYS'].
 */
export function weekdaysFromLeyenda(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  const text = deburr(raw);
  if (text.includes('todos los dias') || text.includes('toda la semana')) {
    return ['ALL_DAYS'];
  }

  // Find every day name mentioned, in order of appearance, keeping positions so
  // we can detect "X a Y" ranges (contiguous span between the two endpoints).
  const found: Array<{ key: string; idx: number }> = [];
  for (const [name, key] of Object.entries(WEEKDAY_KEY_BY_NAME)) {
    let from = 0;
    for (;;) {
      const idx = text.indexOf(name, from);
      if (idx === -1) break;
      found.push({ key, idx });
      from = idx + name.length;
    }
  }
  if (found.length === 0) return [];
  found.sort((a, b) => a.idx - b.idx);

  const keys = new Set<string>();
  // If the text expresses a range ("... a ...") and we have exactly two
  // endpoints, expand the contiguous span between them.
  const isRange = / a | al /.test(text) && found.length === 2;
  if (isRange) {
    const startPos = WEEKDAY_ORDER.indexOf(found[0]!.key);
    const endPos = WEEKDAY_ORDER.indexOf(found[1]!.key);
    if (startPos !== -1 && endPos !== -1 && startPos <= endPos) {
      for (let i = startPos; i <= endPos; i++) keys.add(WEEKDAY_ORDER[i]!);
    }
  }
  if (keys.size === 0) for (const f of found) keys.add(f.key);
  if (keys.size >= 7) return ['ALL_DAYS'];
  return WEEKDAY_ORDER.filter((k) => keys.has(k));
}

/**
 * Spanish two-letter weekday codes used by ICBC's `days` array
 * (["LU","MA","MI","JU","VI","SA","DO"]) → canonical keys.
 */
const WEEKDAY_KEY_BY_CODE: Record<string, string> = {
  LU: 'MONDAY',
  MA: 'TUESDAY',
  MI: 'WEDNESDAY',
  JU: 'THURSDAY',
  VI: 'FRIDAY',
  SA: 'SATURDAY',
  DO: 'SUNDAY',
};

/**
 * Map an array of Spanish two-letter weekday codes (["LU","MA",…]) — ICBC's
 * `days` shape — onto canonical weekday keys. A full week → ['ALL_DAYS'].
 */
export function weekdaysFromDayCodes(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const keys = new Set<string>();
  for (const v of list) {
    const key = WEEKDAY_KEY_BY_CODE[String(v ?? '').trim().toUpperCase()];
    if (key) keys.add(key);
  }
  if (keys.size >= 7) return ['ALL_DAYS'];
  return WEEKDAY_ORDER.filter((k) => keys.has(k));
}

/**
 * Map a day-flags object ({ monday:true, tuesday:false, … }) — Macro's
 * `days-week` shape — onto canonical weekday keys. A full week → ['ALL_DAYS'].
 */
export function weekdaysFromDayFlags(obj: unknown): string[] {
  if (!obj || typeof obj !== 'object') return [];
  const o = obj as Record<string, unknown>;
  const nameToKey: Record<string, string> = {
    monday: 'MONDAY',
    tuesday: 'TUESDAY',
    wednesday: 'WEDNESDAY',
    thursday: 'THURSDAY',
    friday: 'FRIDAY',
    saturday: 'SATURDAY',
    sunday: 'SUNDAY',
  };
  const keys = new Set<string>();
  for (const [day, key] of Object.entries(nameToKey)) {
    if (o[day] === true) keys.add(key);
  }
  if (keys.size >= 7) return ['ALL_DAYS'];
  return WEEKDAY_ORDER.filter((k) => keys.has(k));
}

/**
 * Map Galicia's `mediosDePago` list ([{ tarjeta, tipoTarjeta }]) onto normalized
 * payment-method keys: the coarse CREDITO/DEBITO from `tipoTarjeta`, plus each
 * card network parsed from the card name (Visa/Master/Amex/Cabal).
 */
export function paymentMethodsFromMediosDePago(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out = new Set<string>();
  for (const item of list) {
    const m = (item ?? {}) as Record<string, unknown>;
    const tipo = deburr(String(m['tipoTarjeta'] ?? ''));
    if (tipo.includes('credito')) out.add('CREDITO');
    if (tipo.includes('debito')) out.add('DEBITO');
    const name = deburr(String(m['tarjeta'] ?? ''));
    if (name.includes('visa')) out.add('VISA');
    if (name.includes('master')) out.add('MASTER');
    if (name.includes('amex') || name.includes('american')) out.add('AMEX');
    if (name.includes('cabal')) out.add('CABAL');
  }
  return [...out];
}

/** Strip HTML tags + collapse whitespace/entities to plain text (for T&C blobs). */
export function stripHtml(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&aacute;/gi, 'á').replace(/&eacute;/gi, 'é').replace(/&iacute;/gi, 'í')
    .replace(/&oacute;/gi, 'ó').replace(/&uacute;/gi, 'ú').replace(/&ntilde;/gi, 'ñ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 0 ? text : null;
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
