/**
 * Weekly "altas" rollup for the dashboard.
 *
 * Searchable chains show what the Sunday sweep did. Chains without EAN
 * search cannot be re-checked that way, so the same payload counts real
 * new mappings (relevamiento, revista, pasted URL, scrape) per ISO week.
 */

import { buenosAiresDate, isoWeekOf, type IsoWeek } from '../instore/dates.js';
import {
  classifyMappingOrigin,
  emptyOriginCounts,
  type MappingOrigin,
} from './origins.js';

export interface ChainSweepStat {
  supermarket_id: string;
  ingested: number;
  not_found: number;
  errors: number;
}

export interface WeeklyChain {
  supermarket_id: string;
  has_search: boolean;
  channels: string[];
  mappings_added: number;
  mappings_added_by: Record<MappingOrigin, number>;
  sweep: { ingested: number; not_found: number; errors: number } | null;
}

export interface WeeklyBucket {
  week: string;
  sweep_job_id: string | null;
  chains: WeeklyChain[];
}

export interface WeeklyChainInput {
  id: string;
  hasSearch: boolean;
  channels: string[];
}

export interface WeeklyMappingInput {
  supermarketId: string;
  createdAt: string;
  externalId: string;
  metadata: unknown;
}

export interface WeeklySweepInput {
  id: string;
  createdAt: string;
  chains: ChainSweepStat[];
}

/** Last `count` ISO weeks ending at `todayBa` (YYYY-MM-DD), newest first. */
export function recentIsoWeeks(todayBa: string, count: number): IsoWeek[] {
  const out: IsoWeek[] = [];
  const seen = new Set<string>();
  let cursor = todayBa;
  for (let i = 0; i < 400 && out.length < count; i++) {
    const week = isoWeekOf(cursor);
    if (!seen.has(week.label)) {
      seen.add(week.label);
      out.push(week);
    }
    cursor = shiftDays(cursor, -1);
  }
  return out;
}

function shiftDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function weekLabelOf(isoTimestamp: string): string | null {
  const t = Date.parse(isoTimestamp);
  if (Number.isNaN(t)) return null;
  return isoWeekOf(buenosAiresDate(new Date(t))).label;
}

/**
 * Assemble the weekly payload. Chains are listed even when nothing was added
 * that week (`mappings_added: 0`, `sweep: null`) so a quiet chain is visible.
 * If several sweeps landed in one week, the latest one wins.
 */
export function buildWeeklyReport(input: {
  weeks: IsoWeek[];
  chains: WeeklyChainInput[];
  mappings: WeeklyMappingInput[];
  sweeps: WeeklySweepInput[];
}): WeeklyBucket[] {
  const chainById = new Map(input.chains.map((c) => [c.id, c]));

  const added = new Map<string, Record<MappingOrigin, number>>();
  for (const m of input.mappings) {
    const week = weekLabelOf(m.createdAt);
    if (!week) continue;
    const chain = chainById.get(m.supermarketId);
    const origin = classifyMappingOrigin({
      externalId: m.externalId,
      metadata: m.metadata,
      hasSearch: chain?.hasSearch ?? false,
    });
    const key = `${week}|${m.supermarketId}`;
    const counts = added.get(key) ?? emptyOriginCounts();
    counts[origin] += 1;
    added.set(key, counts);
  }

  const sweepByWeek = new Map<string, WeeklySweepInput>();
  const sweepsNewestFirst = [...input.sweeps].sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : -1,
  );
  for (const s of sweepsNewestFirst) {
    const week = weekLabelOf(s.createdAt);
    if (!week || sweepByWeek.has(week)) continue;
    sweepByWeek.set(week, s);
  }

  return input.weeks.map((week) => {
    const sweep = sweepByWeek.get(week.label) ?? null;
    const sweepByChain = new Map(
      (sweep?.chains ?? []).map((c) => [c.supermarket_id, c]),
    );
    const chains: WeeklyChain[] = input.chains.map((c) => {
      const counts = added.get(`${week.label}|${c.id}`) ?? emptyOriginCounts();
      const mappingsAdded = counts.scrape + counts.manual_url + counts.instore + counts.revista;
      const stat = sweepByChain.get(c.id);
      return {
        supermarket_id: c.id,
        has_search: c.hasSearch,
        channels: c.channels,
        mappings_added: mappingsAdded,
        mappings_added_by: counts,
        // Null when the chain cannot be searched, or it was not in that
        // week's sweep summary (inactive, or nothing missing to search).
        sweep:
          c.hasSearch && stat
            ? { ingested: stat.ingested, not_found: stat.not_found, errors: stat.errors }
            : null,
      };
    });
    return {
      week: week.label,
      sweep_job_id: sweep?.id ?? null,
      chains,
    };
  });
}
