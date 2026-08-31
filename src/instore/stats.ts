/**
 * Weekly in-store volume for the back-office summary table
 * ("productos relevados por súper por semana").
 *
 * `/entries` is single-day + paginated and `/visits` has no entry counts
 * across a range, so the frontend can't build that table client-side.
 */

import { db, fetchAllPages } from '../shared/db.js';
import {
  aggregateWeeklyStats,
  baDateRangeUtc,
  type WeeklyStatRow,
} from './dates.js';

export type { WeeklyStatRow };

interface EntryStatRow {
  supermarket_id: string;
  created_at: string;
  review_status: string;
  supermarkets: { name: string; cadena_display_name: string | null } | { name: string; cadena_display_name: string | null }[] | null;
}

function firstJoin<T>(v: T | T[] | null | undefined): T | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

/**
 * Entry counts per supermarket × ISO week for a Buenos Aires date range
 * (inclusive). Rejected rows are omitted.
 */
export async function loadWeeklyStats(from: string, to: string): Promise<WeeklyStatRow[]> {
  const { fromUtc, toUtc } = baDateRangeUtc(from, to);
  const rows = await fetchAllPages<EntryStatRow>((fromIdx, toIdx) =>
    db
      .from('instore_price_entries')
      .select('supermarket_id, created_at, review_status, supermarkets(name, cadena_display_name)')
      .gte('created_at', fromUtc)
      .lt('created_at', toUtc)
      .neq('review_status', 'rejected')
      .order('created_at', { ascending: true })
      .range(fromIdx, toIdx),
  );

  return aggregateWeeklyStats(
    rows.map((r) => {
      const store = firstJoin(r.supermarkets);
      return {
        supermarket_id: r.supermarket_id,
        supermarket_name: store?.cadena_display_name ?? store?.name ?? null,
        created_at: r.created_at,
        review_status: r.review_status,
      };
    }),
  );
}
