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
