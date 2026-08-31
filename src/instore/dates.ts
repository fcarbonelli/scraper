/**
 * Buenos Aires calendar-day helpers shared by in-store routes.
 *
 * Argentina is UTC-3 year-round (no DST). The client export and every
 * "today" default in this module use America/Argentina/Buenos_Aires so a
 * worker finishing a visit at 22:00 in San Martín still lands on the
 * same business day the back-office review tab shows.
 */

/** Argentina is UTC-3 year-round (no DST) — the offset the export's day uses. */
export const AR_OFFSET = '-03:00';

/** Today's date (YYYY-MM-DD) in Buenos Aires. */
export function todayInBuenosAires(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
  }).format(new Date());
}

/** YYYY-MM-DD for an arbitrary instant in Buenos Aires. */
export function buenosAiresDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
  }).format(d);
}

/** UTC [from, to) range covering one Buenos Aires calendar day. */
export function baDayRangeUtc(date: string): { fromUtc: string; toUtc: string } {
  const fromUtc = new Date(`${date}T00:00:00${AR_OFFSET}`).toISOString();
  const toUtc = new Date(`${date}T00:00:00${AR_OFFSET}`);
  toUtc.setUTCDate(toUtc.getUTCDate() + 1);
  return { fromUtc, toUtc: toUtc.toISOString() };
}

/**
 * UTC [from, to) covering an inclusive Buenos Aires date range.
 * A single day is `from === to`; an open-ended range is not supported.
 */
export function baDateRangeUtc(
  fromDate: string,
  toDate: string,
): { fromUtc: string; toUtc: string } {
  const { fromUtc } = baDayRangeUtc(fromDate);
  const { toUtc } = baDayRangeUtc(toDate);
  return { fromUtc, toUtc };
}

/** ISO-week identity for a YYYY-MM-DD date (Monday-based, ISO-8601). */
export interface IsoWeek {
  /** ISO week-numbering year (can differ from the calendar year near Jan/Dec). */
  isoYear: number;
  /** ISO week number, 1–53. */
  isoWeek: number;
  /** Sortable label, e.g. "2026-W34". */
  label: string;
  /** Monday of that ISO week, as YYYY-MM-DD. */
  weekStart: string;
}

/**
 * ISO-8601 week for a YYYY-MM-DD date. Matches Postgres `EXTRACT(WEEK …)` (used
 * by the client_base view), so the "por semana" grouping lines up with exports.
 * We operate on the plain calendar date (already resolved to Buenos Aires by the
 * caller), so no timezone maths leak in here.
 */
export function isoWeekOf(dateStr: string): IsoWeek {
  const [y, m, d] = dateStr.split('-').map(Number) as [number, number, number];

  // Shift to the Thursday of the current week: the ISO year/week are defined by
  // the week's Thursday. dayNum is 0=Mon … 6=Sun.
  const date = new Date(Date.UTC(y, m - 1, d));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const isoYear = date.getUTCFullYear();

  // Week 1 is the week containing Jan 4th; count weeks from its Thursday.
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstThursdayDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayDayNum + 3);
  const isoWeek = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86_400_000));

  // Monday of the ORIGINAL date's week (not the shifted Thursday).
  const monday = new Date(Date.UTC(y, m - 1, d));
  monday.setUTCDate(monday.getUTCDate() - dayNum);

  return {
    isoYear,
    isoWeek,
    label: `${isoYear}-W${String(isoWeek).padStart(2, '0')}`,
    weekStart: monday.toISOString().slice(0, 10),
  };
}
