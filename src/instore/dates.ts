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

/**
 * ISO week label (`2026-W35`) for a Buenos Aires calendar day.
 * The date is treated as a calendar day (no time), so the ISO week
 * matches what a BA operator sees on a wall calendar.
 */
export function isoWeekLabel(yyyyMmDd: string): string {
  const parts = yyyyMmDd.split('-').map(Number);
  const y = parts[0];
  const m = parts[1];
  const d = parts[2];
  if (y == null || m == null || d == null) {
    throw new Error(`isoWeekLabel: expected YYYY-MM-DD, got ${yyyyMmDd}`);
  }
  // Thursday of this week decides the ISO year. Work in UTC so the
  // calendar day doesn't shift with the server timezone.
  const date = new Date(Date.UTC(y, m - 1, d));
  const day = date.getUTCDay() || 7; // Mon=1 … Sun=7
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const isoYear = date.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const week1Thursday = new Date(jan4);
  week1Thursday.setUTCDate(jan4.getUTCDate() + 4 - jan4Day);
  const week = 1 + Math.round((date.getTime() - week1Thursday.getTime()) / (7 * 86_400_000));
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

export interface WeeklyStatRow {
  supermarket_id: string;
  supermarket_name: string | null;
  /** ISO week, e.g. `2026-W35`. */
  week: string;
  count: number;
}

/**
 * Group entries by supermarket + ISO week (BA calendar).
 * Rejected entries are excluded — they were discarded, not relevados.
 */
export function aggregateWeeklyStats(
  rows: Array<{
    supermarket_id: string;
    supermarket_name: string | null;
    created_at: string;
    review_status: string;
  }>,
): WeeklyStatRow[] {
  const counts = new Map<string, WeeklyStatRow>();
  for (const r of rows) {
    if (r.review_status === 'rejected') continue;
    const week = isoWeekLabel(buenosAiresDate(new Date(r.created_at)));
    const key = `${r.supermarket_id}|${week}`;
    const prev = counts.get(key);
    if (prev) {
      prev.count += 1;
    } else {
      counts.set(key, {
        supermarket_id: r.supermarket_id,
        supermarket_name: r.supermarket_name,
        week,
        count: 1,
      });
    }
  }

  return [...counts.values()].sort((a, b) => {
    const weekCmp = a.week.localeCompare(b.week);
    if (weekCmp !== 0) return weekCmp;
    return (a.supermarket_name ?? a.supermarket_id).localeCompare(
      b.supermarket_name ?? b.supermarket_id,
      'es',
    );
  });
}
