/**
 * Report / collapse real revista snapshot duplicates + report EAN collisions.
 *
 * Real duplicates = same supermarket_product_id + same BA day + revista source
 * (multiple snapshots). Rule: offer wins, else newest. EAN collisions
 * (same EAN, distinct product_ids) are REPORTED ONLY — never auto-deleted.
 *
 * Usage (PowerShell-safe):
 *   npx tsx --env-file=.env scripts/revistas-dedupe-cleanup.ts
 *   npx tsx --env-file=.env scripts/revistas-dedupe-cleanup.ts --apply
 *   npx tsx --env-file=.env scripts/revistas-dedupe-cleanup.ts --day=2026-07-20
 *   npx tsx --env-file=.env scripts/revistas-dedupe-cleanup.ts --days=3
 *   npx tsx --env-file=.env scripts/revistas-dedupe-cleanup.ts --super=rosental
 *
 * Default is report-only. Pass --apply to delete losing snapshot rows.
 * `--days=3` = only the last 3 Buenos Aires calendar days (incl. today) —
 * useful to check whether dupes are recent or from an old bad day (e.g. Jul 14).
 *
 * Works without migration 013 — derives the BA day from scraped_at (does not
 * require the scraped_on column). The control-view API
 * (`GET /v1/revistas/duplicates` + `POST /duplicates/resolve`) is the preferred
 * operator path; this script is for offline/ops use.
 */

import { db } from '../src/shared/db.js';
import {
  buenosAiresDate,
  findEanCollisions,
  losersAmongDuplicates,
  pickWinnerAmongDuplicates,
  type DedupCandidate,
} from '../src/revistas/pricing.js';

/* eslint-disable no-console */

function getArg(name: string): string | undefined {
  const pref = `--${name}=`;
  return process.argv.find((a) => a.startsWith(pref))?.slice(pref.length);
}

/**
 * Last N Buenos Aires calendar days as YYYY-MM-DD, including today.
 * e.g. days=3 on Jul 21 → {2026-07-19, 2026-07-20, 2026-07-21}.
 */
function lastBaDays(n: number, now = new Date()): Set<string> {
  const today = buenosAiresDate(now);
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const out = new Set<string>();
  for (let i = 0; i < n; i++) {
    // Calendar arithmetic in UTC so month boundaries stay correct.
    const dt = new Date(Date.UTC(y, m - 1, d - i));
    out.add(dt.toISOString().slice(0, 10));
  }
  return out;
}

interface SnapRow extends DedupCandidate {
  id: number;
  supermarket_product_id: string;
  scraped_at: string;
  price: number | null;
  promotion_1: string | null;
  offer_price_1: number | null;
  raw_data: { source?: string } | null;
}

/** BA calendar day from scraped_at (works before migration 013 adds scraped_on). */
function snapDay(s: { scraped_at: string }): string {
  return buenosAiresDate(new Date(s.scraped_at));
}

interface MappingInfo {
  id: string;
  supermarket_id: string;
  product_id: string;
  ean: string | null;
  name: string | null;
}

async function loadRevistaMappings(supermarketId?: string): Promise<MappingInfo[]> {
  let q = db
    .from('supermarket_products')
    .select('id, supermarket_id, product_id, products(ean, name), metadata')
    .eq('metadata->>source', 'revista');
  if (supermarketId) q = q.eq('supermarket_id', supermarketId);
  const { data, error } = await q.limit(10000);
  if (error) throw error;
  return ((data ?? []) as unknown as Array<{
    id: string;
    supermarket_id: string;
    product_id: string;
    products: { ean: string | null; name: string | null } | null;
  }>).map((r) => ({
    id: r.id,
    supermarket_id: r.supermarket_id,
    product_id: r.product_id,
    ean: r.products?.ean ?? null,
    name: r.products?.name ?? null,
  }));
}

async function loadSnapshots(spIds: string[]): Promise<SnapRow[]> {
  const out: SnapRow[] = [];
  for (let i = 0; i < spIds.length; i += 200) {
    const chunk = spIds.slice(i, i + 200);
    let from = 0;
    for (;;) {
      // Do NOT select scraped_on — that column only exists after migration 013,
      // and this script is meant to run BEFORE that migration.
      const { data, error } = await db
        .from('price_snapshots')
        .select(
          'id, supermarket_product_id, scraped_at, price, promotion_1, offer_price_1, raw_data',
        )
        .in('supermarket_product_id', chunk)
        .is('scrape_run_id', null)
        .order('id', { ascending: true })
        .range(from, from + 999);
      if (error) throw error;
      const batch = (data ?? []) as SnapRow[];
      for (const row of batch) {
        const src = row.raw_data?.source;
        if (src === 'revista' || src === 'revista-carry-forward' || !src) {
          out.push(row);
        }
      }
      if (batch.length < 1000) break;
      from += 1000;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const dayFilter = getArg('day');
  const daysRaw = getArg('days');
  const superFilter = getArg('super');

  if (dayFilter && daysRaw) {
    console.error('Use either --day=YYYY-MM-DD or --days=N, not both.');
    process.exit(1);
  }

  const daysWindow =
    daysRaw != null
      ? lastBaDays(Math.max(1, Number.parseInt(daysRaw, 10) || 1))
      : null;

  const dayAllowed = (day: string): boolean => {
    if (dayFilter) return day === dayFilter;
    if (daysWindow) return daysWindow.has(day);
    return true;
  };

  console.log('\nREVISTA DEDUPE CLEANUP');
  console.log(`mode: ${apply ? 'APPLY (will delete losers)' : 'REPORT ONLY (pass --apply to delete)'}`);
  if (dayFilter) console.log(`day filter: ${dayFilter}`);
  if (daysWindow) {
    console.log(`days window (last ${daysWindow.size} BA days): ${[...daysWindow].sort().join(', ')}`);
  }
  if (superFilter) console.log(`supermarket: ${superFilter}`);
  console.log('');

  const mappings = await loadRevistaMappings(superFilter);
  console.log(`revista mappings: ${mappings.length}`);
  if (mappings.length === 0) {
    console.log('Nothing to do.');
    process.exit(0);
  }

  const mapById = new Map(mappings.map((m) => [m.id, m]));
  const snaps = await loadSnapshots(mappings.map((m) => m.id));
  console.log(`run-less revista-ish snapshots: ${snaps.length}`);

  // Group by (mapping, BA day).
  const groups = new Map<string, SnapRow[]>();
  for (const s of snaps) {
    const day = snapDay(s);
    if (!dayAllowed(day)) continue;
    const key = `${s.supermarket_product_id}|${day}`;
    const list = groups.get(key) ?? [];
    list.push(s);
    groups.set(key, list);
  }

  const duplicateGroups = [...groups.entries()].filter(([, rows]) => rows.length > 1);

  // Quick per-day tally so you can see if dupes cluster on one bad day (e.g. Jul 14).
  const byDay = new Map<string, number>();
  for (const [key] of duplicateGroups) {
    const day = key.split('|')[1] ?? '?';
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  console.log(`\n--- Real duplicates (same mapping + day, >1 snapshot): ${duplicateGroups.length} ---`);
  if (byDay.size > 0) {
    console.log('  by day:');
    for (const [day, n] of [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      console.log(`    ${day}: ${n} group(s)`);
    }
  }

  const toDelete: number[] = [];
  for (const [key, rows] of duplicateGroups) {
    const [spId, day] = key.split('|');
    const info = mapById.get(spId ?? '');
    const winner = pickWinnerAmongDuplicates(rows);
    const losers = losersAmongDuplicates(rows);
    console.log(
      `  ${info?.supermarket_id ?? '?'} ean=${info?.ean ?? '∅'} day=${day} ` +
        `keep=#${winner?.id} (price=${winner?.price}, promo=${winner?.promotion_1 ?? '∅'}) ` +
        `drop=[${losers.map((l) => l.id).join(',')}]  ${info?.name ?? ''}`,
    );
    for (const l of losers) toDelete.push(l.id as number);
  }

  // EAN collisions (report only).
  const collisionInput = snaps
    .filter((s) => dayAllowed(snapDay(s)))
    .map((s) => {
      const info = mapById.get(s.supermarket_product_id);
      return {
        ean: info?.ean ?? '',
        supermarket_id: info?.supermarket_id ?? '',
        day: snapDay(s),
        product_id: info?.product_id ?? '',
        name: info?.name ?? null,
        snapshot_id: s.id,
      };
    });
  const collisions = findEanCollisions(collisionInput);
  console.log(`\n--- EAN collisions (same EAN, distinct products — DO NOT auto-delete): ${collisions.length} ---`);
  for (const g of collisions) {
    console.log(
      `  ${g.supermarket_id} ean=${g.ean} day=${g.day} products=[${g.product_ids.join(', ')}]`,
    );
    for (const r of g.rows) {
      console.log(`     • product=${r.product_id} snap=#${r.snapshot_id} name=${r.name ?? ''}`);
    }
    console.log('     → fix via control view rematch / heal-eans (human)');
  }

  console.log(`\nSummary: would delete ${toDelete.length} duplicate snapshot(s); ${collisions.length} collision group(s) need human review.`);

  if (apply && toDelete.length > 0) {
    console.log(`\nDeleting ${toDelete.length} snapshot(s)...`);
    for (let i = 0; i < toDelete.length; i += 200) {
      const chunk = toDelete.slice(i, i + 200);
      const { error } = await db.from('price_snapshots').delete().in('id', chunk);
      if (error) throw error;
    }
    console.log('Done.');
  } else if (apply) {
    console.log('Nothing to delete.');
  } else {
    console.log('Re-run with --apply to delete the losing duplicate rows.');
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
