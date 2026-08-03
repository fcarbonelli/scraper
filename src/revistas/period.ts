/**
 * Parse the validity period a flyer advertises in its own title.
 *
 * Chains embed the period in the label ("Folder 03.08 al 09.08 | RESTO",
 * "Ofertas semanales del 30/07 al 05/08"). Until now that text was only ever
 * thrown away — `stripDateNoise` in series.ts removes it to derive a series
 * key. Parsing it instead gives the pipeline the one thing it never modelled:
 * WHEN a flyer is valid, as opposed to `detected_at`, which is only when we
 * happened to see it.
 *
 * Three rules this module lives by:
 *
 *   1. No label carries a year. It is inferred from the detection date, with a
 *      correction for periods that wrap December→January in either direction.
 *   2. Returning `null` is the normal case, not a failure. Rosental titles
 *      ("Agosto primera quincena", "PubHTML5 flipbook") and Makro filenames
 *      ("jul2mm.pdf") often carry no parseable period at all.
 *   3. The period is enrichment, never an identity. Dedup still keys on
 *      `content_hash`; nothing here may become a primary key.
 */

import { buenosAiresDate } from './pricing.js';

export interface FlyerPeriod {
  /** YYYY-MM-DD */
  start: string;
  /** YYYY-MM-DD, inclusive. Equals `start` for single-day flyers. */
  end: string;
  /**
   * `exact` — both endpoints read off explicit day/month pairs.
   * `inferred` — derived from a coarser phrase ("Agosto primera quincena").
   * Callers must not let an `inferred` period decide on its own whether to
   * skip a magazine: a guessed fortnight is not evidence.
   */
  confidence: 'exact' | 'inferred';
}

const MONTHS: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10,
  noviembre: 11, diciembre: 12,
};

const MS_PER_DAY = 86_400_000;
/** Half a year: past this gap the inferred year is the wrong side of a Dec→Jan wrap. */
const WRAP_THRESHOLD_DAYS = 180;

/** Combining marks NFD leaves behind, so "Gastronómicas" matches "gastronomicas". */
const COMBINING_MARKS = /[\u0300-\u036f]/g;

function deaccent(s: string): string {
  return s.normalize('NFD').replace(COMBINING_MARKS, '').toLowerCase();
}

function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

function iso(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Attach a year to a bare day/month range.
 *
 * The flyer is always published near its own period, so the detection date is
 * the anchor. Two corrections: an end before the start means the range crosses
 * into the next year, and a range that lands more than half a year away from
 * the detection date is on the wrong side of a December→January wrap.
 */
function resolveYears(
  startMonth: number,
  startDay: number,
  endMonth: number,
  endDay: number,
  detectedAt: Date,
): { start: string; end: string } | null {
  const [detYear, detMonth, detDay] = buenosAiresDate(detectedAt)
    .split('-')
    .map(Number) as [number, number, number];
  const detected = Date.UTC(detYear, detMonth - 1, detDay);

  let startYear = detYear;
  let endYear = endMonth < startMonth || (endMonth === startMonth && endDay < startDay)
    ? detYear + 1
    : detYear;

  for (let attempt = 0; attempt < 3; attempt++) {
    if (!isRealDate(startYear, startMonth, startDay) || !isRealDate(endYear, endMonth, endDay)) {
      return null;
    }
    const start = Date.UTC(startYear, startMonth - 1, startDay);
    const end = Date.UTC(endYear, endMonth - 1, endDay);

    if ((start - detected) / MS_PER_DAY > WRAP_THRESHOLD_DAYS) {
      startYear -= 1;
      endYear -= 1;
      continue;
    }
    if ((detected - end) / MS_PER_DAY > WRAP_THRESHOLD_DAYS) {
      startYear += 1;
      endYear += 1;
      continue;
    }
    return { start: iso(startYear, startMonth, startDay), end: iso(endYear, endMonth, endDay) };
  }
  return null;
}

/**
 * Numeric capture groups as a plain array, or null when the match is absent or
 * a group did not parse. Keeps `noUncheckedIndexedAccess` satisfied without a cast.
 */
function groups(m: RegExpExecArray | null, count: number): number[] | null {
  if (!m) return null;
  const out: number[] = [];
  for (let i = 1; i <= count; i++) {
    const n = Number(m[i]);
    if (!Number.isInteger(n)) return null;
    out.push(n);
  }
  return out.length === count ? out : null;
}

/** `at(i)` with the undefined already ruled out by {@link groups}. */
function at(nums: number[], i: number): number {
  return nums[i] ?? 0;
}

/**
 * `03.08 al 09.08`, `del 30/07 al 05/08`. Only `.` and `/` separate day from
 * month — allowing `-` would read "sponjun4-2.pdf" as a date.
 */
const RANGE_RE =/(\d{1,2})[./](\d{1,2})\s*(?:al|a)\s+(\d{1,2})[./](\d{1,2})/i;

/** `3/8`, `23.07` — a one-day flyer ("Aviso Solo por LUNES 3/8"). */
const SINGLE_RE = /(\d{1,2})[./](\d{1,2})(?!\d)/;

/** `Agosto primera quincena`, `primera quincena de agosto`. */
const QUINCENA_RE = /(primera|segunda|1ra|2da|1era)\s+quincena|quincena/i;

export function parseFlyerPeriod(label: string, detectedAt: Date): FlyerPeriod | null {
  if (!label) return null;
  const text = deaccent(label);

  const range = groups(RANGE_RE.exec(text), 4);
  if (range) {
    const resolved = resolveYears(at(range, 1), at(range, 0), at(range, 3), at(range, 2), detectedAt);
    if (resolved) return { ...resolved, confidence: 'exact' };
  }

  const single = groups(SINGLE_RE.exec(text), 2);
  if (single) {
    const day = at(single, 0);
    const month = at(single, 1);
    const resolved = resolveYears(month, day, month, day, detectedAt);
    if (resolved) return { ...resolved, confidence: 'exact' };
  }

  if (QUINCENA_RE.test(text)) {
    const month = Object.keys(MONTHS).find((name) => text.includes(name));
    if (month) {
      const monthNum = MONTHS[month]!;
      const second = /(segunda|2da)\s+quincena/i.test(text);
      const detYear = Number(buenosAiresDate(detectedAt).slice(0, 4));
      const startDay = second ? 16 : 1;
      const endDay = second ? lastDayOfMonth(detYear, monthNum) : 15;
      const resolved = resolveYears(monthNum, startDay, monthNum, endDay, detectedAt);
      if (resolved) return { ...resolved, confidence: 'inferred' };
    }
  }

  return null;
}

/** True when both periods are known and cover the same days. */
export function samePeriod(a: FlyerPeriod | null, b: FlyerPeriod | null): boolean {
  if (!a || !b) return false;
  return a.start === b.start && a.end === b.end;
}
