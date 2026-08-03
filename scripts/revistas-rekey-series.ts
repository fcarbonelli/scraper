/**
 * One-off migration: re-key `series_key` after dropping Vital's branch suffix,
 * backfill `period_start`/`period_end`, and repair the supersede chains the
 * old rule broke.
 *
 * Why this exists
 * ---------------
 * Vital rotates which locality's flyer is on display ("| RESTO" one week,
 * "| MALVINAS - ABASTO" the next). The series key was derived from that string,
 * so a rotation forked one flyer line into two series — and a new series
 * supersedes nothing, which left the EXPIRED edition current and still feeding
 * prices into the client export every day. Changing the derivation alone fixes
 * nothing: the stored rows keep the old keys, so the next edition would not
 * supersede them either.
 *
 * What it deliberately does NOT do
 * --------------------------------
 * It only touches rows where the OLD and NEW derivations disagree. Many stored
 * keys predate the TypeScript rule entirely — migration 015 backfilled them
 * with a SQL CASE, so `jul2mm.pdf` is stored as `mm` while the code derives
 * `jul2mm-pdf`, and `Ofertas especiales…` is stored `prov` while the code says
 * `sponsor`. Re-deriving everything would silently rewrite Makro's keys and
 * scramble supersede chains that are working fine. That drift is pre-existing
 * and out of scope.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/revistas-rekey-series.ts               # dry run
 *   npx tsx --env-file=.env scripts/revistas-rekey-series.ts --apply
 *   npx tsx --env-file=.env scripts/revistas-rekey-series.ts --rollback=<file>
 *
 * `--apply` writes a rollback file first (ids, previous keys, previous
 * supersede pointers, and every mapping it is about to pause), because this
 * changes what the client export emits TODAY and "undo" must not mean hand
 * repair across 50-odd rows.
 *
 * Requires migration 023 to be applied first (period_start / period_end).
 */

import { writeFileSync, readFileSync } from 'node:fs';
import { db } from '../src/shared/db.js';
import {
  deriveSeriesKey,
  legacySeriesKeyFromVitalDataName,
  seriesKeyFromVitalDataName,
} from '../src/revistas/series.js';
import { parseFlyerPeriod } from '../src/revistas/period.js';
import { supersedePreviousMagazines } from '../src/revistas/store.js';
import { pauseSupersededSeriesMappings } from '../src/revistas/approve.js';

/* eslint-disable no-console */

interface Row {
  id: string;
  supermarket_id: string;
  label: string;
  series_key: string | null;
  source_strategy: string;
  detected_at: string;
  status: string;
  superseded_by: string | null;
  superseded_at: string | null;
  period_start: string | null;
  period_end: string | null;
  period_confidence: string | null;
}

interface RollbackEntry {
  id: string;
  series_key: string | null;
  superseded_by: string | null;
  superseded_at: string | null;
  period_start: string | null;
  period_end: string | null;
  period_confidence: string | null;
}

interface RollbackFile {
  created_at: string;
  magazines: RollbackEntry[];
  paused_mapping_note: string;
}

function getArg(name: string): string | undefined {
  const pref = `--${name}=`;
  return process.argv.find((a) => a.startsWith(pref))?.slice(pref.length);
}

/**
 * Reconstruct which argument carried the label, mirroring `toPdfLink`
 * (download.ts): Vital anchors supply `data-name`, Makro anchors a `title`,
 * everything else falls back to the filename.
 */
function isVitalDataName(row: Row): boolean {
  if (row.source_strategy !== 'html-pdf-links') return false;
  return row.label.includes('|') || /\([^)]*\)\s*$/.test(row.label);
}

function nextSeriesKey(row: Row): string {
  if (row.source_strategy !== 'html-pdf-links') return 'default';
  if (isVitalDataName(row)) return seriesKeyFromVitalDataName(row.label);
  const isFilename = row.label.toLowerCase().endsWith('.pdf');
  return deriveSeriesKey({
    ...(isFilename ? { filename: row.label } : { title: row.label }),
    label: row.label,
    strategy: 'html-pdf-links',
  });
}

function legacySeriesKey(row: Row): string {
  if (!isVitalDataName(row)) return nextSeriesKey(row);
  return legacySeriesKeyFromVitalDataName(row.label);
}

const BASE_COLS =
  'id, supermarket_id, label, series_key, source_strategy, detected_at, status, superseded_by, superseded_at';

/**
 * Read the rows, tolerating a database where migration 023 has not been applied
 * yet. The dry run is the whole point of this script — refusing to show the
 * series diff because an unrelated column is missing would defeat it.
 */
async function loadRows(): Promise<{ rows: Row[]; hasPeriodColumns: boolean }> {
  const withPeriod = await db
    .from('revista_magazines')
    .select(`${BASE_COLS}, period_start, period_end, period_confidence`)
    .order('detected_at', { ascending: true });
  if (!withPeriod.error) {
    return { rows: (withPeriod.data ?? []) as Row[], hasPeriodColumns: true };
  }
  if (!String(withPeriod.error.message ?? '').includes('period_')) throw withPeriod.error;

  const { data, error } = await db
    .from('revista_magazines')
    .select(BASE_COLS)
    .order('detected_at', { ascending: true });
  if (error) throw error;
  const rows = (data ?? []).map((r) => ({
    ...(r as Omit<Row, 'period_start' | 'period_end'>),
    period_start: null,
    period_end: null,
    period_confidence: null,
  }));
  return { rows, hasPeriodColumns: false };
}

/** Review-item tally for one magazine — only approved items reach the export. */
async function countItems(magazineId: string): Promise<{ total: number; approved: number }> {
  const { data, error } = await db
    .from('revista_review_items')
    .select('status')
    .eq('magazine_id', magazineId);
  if (error) throw error;
  const rows = data ?? [];
  return { total: rows.length, approved: rows.filter((r) => r.status === 'approved').length };
}

async function rollback(file: string): Promise<void> {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as RollbackFile;
  console.log(`Restoring ${parsed.magazines.length} magazine row(s) from ${file}`);
  for (const m of parsed.magazines) {
    const { error } = await db
      .from('revista_magazines')
      .update({
        series_key: m.series_key,
        superseded_by: m.superseded_by,
        superseded_at: m.superseded_at,
        period_start: m.period_start,
        period_end: m.period_end,
        period_confidence: m.period_confidence,
      })
      .eq('id', m.id);
    if (error) throw error;
  }
  console.log('Magazines restored.');
  console.log(parsed.paused_mapping_note);
}

async function main(): Promise<void> {
  const rollbackFile = getArg('rollback');
  if (rollbackFile) {
    await rollback(rollbackFile);
    process.exit(0);
  }

  const apply = process.argv.includes('--apply');
  const { rows, hasPeriodColumns } = await loadRows();
  console.log(`Read ${rows.length} magazine row(s).`);
  if (!hasPeriodColumns) {
    console.log('⚠️  migration 023 not applied — period_start/period_end are missing.');
  }
  console.log('');

  const rekeys: { row: Row; from: string; to: string }[] = [];
  const periods: { row: Row; start: string; end: string; confidence: string }[] = [];

  for (const row of rows) {
    const legacy = legacySeriesKey(row);
    const next = nextSeriesKey(row);
    // Only rows this change is responsible for. See the header note.
    if (legacy !== next) rekeys.push({ row, from: row.series_key ?? '(null)', to: next });

    const period = parseFlyerPeriod(row.label, new Date(row.detected_at));
    if (
      period &&
      (row.period_start !== period.start ||
        row.period_end !== period.end ||
        row.period_confidence !== period.confidence)
    ) {
      periods.push({ row, start: period.start, end: period.end, confidence: period.confidence });
    }
  }

  console.log(`── series_key: ${rekeys.length} row(s) to re-key ──`);
  for (const r of rekeys) {
    console.log(`  ${r.row.supermarket_id.padEnd(9)} ${r.from.padEnd(30)} → ${r.to.padEnd(20)} "${r.row.label}"`);
  }
  const touchedChains = new Set(rekeys.map((r) => r.row.supermarket_id));
  console.log(`  chains touched: ${[...touchedChains].join(', ') || '(none)'}\n`);

  console.log(`── period backfill: ${periods.length} row(s) ──`);
  for (const p of periods) {
    console.log(
      `  ${p.row.supermarket_id.padEnd(9)} ${p.start} → ${p.end} (${p.confidence.padEnd(8)}) "${p.row.label}"`,
    );
  }
  const noPeriod = rows.length - periods.length;
  console.log(`  (${noPeriod} row(s) already correct or carry no parseable period)\n`);

  // Pass 2 preview. Re-keying is reversible bookkeeping; THIS is the part that
  // changes what the client export emits today, so the dry run has to show it.
  // The key each row will ACTUALLY hold after pass 1: the new value only for
  // rows being re-keyed, the stored value for everyone else. Deriving it for
  // all rows would invent collisions that never happen — Makro's stored keys
  // come from migration 015's SQL backfill and are deliberately left alone.
  const rekeyed = new Map(rekeys.map((r) => [r.row.id, r.to]));
  const futureKey = new Map(
    rows.map((r) => [r.id, rekeyed.get(r.id) ?? r.series_key ?? 'default']),
  );
  const liveBySeries = new Map<string, Row[]>();
  for (const row of rows) {
    if (row.superseded_by !== null) continue;
    if (row.status !== 'in_review' && row.status !== 'reviewed') continue;
    const key = `${row.supermarket_id}::${futureKey.get(row.id)}`;
    liveBySeries.set(key, [...(liveBySeries.get(key) ?? []), row]);
  }

  const collisions = [...liveBySeries.entries()].filter(([, rs]) => rs.length > 1);
  console.log(`── supersede: ${collisions.length} serie(s) con más de una vigente ──`);
  for (const [key, rs] of collisions) {
    const sorted = [...rs].sort((a, b) => b.detected_at.localeCompare(a.detected_at));
    const keep = sorted[0];
    console.log(`  ${key}`);
    console.log(`    queda vigente : "${keep?.label}"`);
    for (const r of sorted.slice(1)) {
      const items = await countItems(r.id);
      console.log(
        `    se supersedea : "${r.label}" — ${items.approved} aprobado(s) de ${items.total}` +
          (items.approved > 0 ? '  ⚠️  sus precios salen del export' : ''),
      );
    }
  }

  // Expired-but-alone: no newer edition, so supersede cannot help them.
  const today = new Date().toISOString().slice(0, 10);
  const orphanExpired: { row: Row; approved: number }[] = [];
  for (const [, rs] of liveBySeries) {
    if (rs.length > 1) continue;
    const row = rs[0];
    if (!row) continue;
    const period = parseFlyerPeriod(row.label, new Date(row.detected_at));
    if (!period || period.end >= today) continue;
    const items = await countItems(row.id);
    if (items.approved > 0) orphanExpired.push({ row, approved: items.approved });
  }
  if (orphanExpired.length > 0) {
    console.log(`\n── vencidas que el re-key NO resuelve: ${orphanExpired.length} ──`);
    console.log('   (no llegó una edición nueva de esa serie, así que nada las supersedea)');
    for (const o of orphanExpired) {
      console.log(
        `  ${o.row.supermarket_id.padEnd(9)} "${o.row.label}" — ${o.approved} aprobado(s), id=${o.row.id}`,
      );
    }
    console.log('   → bajar a mano con POST /v1/revistas/:id/deactivate');
  }
  console.log('');

  if (!apply) {
    console.log('DRY RUN — nothing written. Re-run with --apply to commit.');
    process.exit(0);
  }

  if (!hasPeriodColumns) {
    console.error('Refusing to write: apply migrations/023_revista_period.sql first.');
    console.error('The rollback file records period columns, so committing without them');
    console.error('would produce a snapshot that cannot restore the row it came from.');
    process.exit(1);
  }

  // Rollback snapshot BEFORE the first write.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = `revista-rekey-rollback-${stamp}.json`;
  const affected = new Set([...rekeys.map((r) => r.row.id), ...periods.map((p) => p.row.id)]);
  const payload: RollbackFile = {
    created_at: new Date().toISOString(),
    magazines: rows
      .filter((r) => affected.has(r.id))
      .map((r) => ({
        id: r.id,
        series_key: r.series_key,
        superseded_by: r.superseded_by,
        superseded_at: r.superseded_at,
        period_start: r.period_start,
        period_end: r.period_end,
        period_confidence: r.period_confidence,
      })),
    paused_mapping_note:
      'Mappings paused by the reconcile pass are NOT restored automatically: re-run ' +
      'scripts/revistas-reconcile-active.ts, or reactivate the magazine via ' +
      'POST /v1/revistas/:id/activate, which re-emits its approved prices.',
  };
  writeFileSync(outFile, JSON.stringify(payload, null, 2));
  console.log(`Rollback snapshot written to ${outFile}\n`);

  // PASS 1 — rewrite every key and period first. Reconciling as we go would
  // supersede against a half-migrated key space.
  for (const r of rekeys) {
    const { error } = await db
      .from('revista_magazines')
      .update({ series_key: r.to })
      .eq('id', r.row.id);
    if (error) throw error;
  }
  for (const p of periods) {
    const { error } = await db
      .from('revista_magazines')
      .update({ period_start: p.start, period_end: p.end, period_confidence: p.confidence })
      .eq('id', p.row.id);
    if (error) throw error;
  }
  console.log(`Pass 1 done: ${rekeys.length} re-keyed, ${periods.length} periods filled.\n`);

  // PASS 2 — one current issue per affected series. Merging two forks means
  // both rows now claim `superseded_by IS NULL`; the newest wins and the rest
  // get superseded, which also pauses their mappings so the expired flyer stops
  // paying out.
  const affectedSeries = new Set(rekeys.map((r) => `${r.row.supermarket_id}::${r.to}`));
  let supersededTotal = 0;
  let pausedTotal = 0;

  for (const key of affectedSeries) {
    const [supermarketId, seriesKey] = key.split('::') as [string, string];
    const { data, error } = await db
      .from('revista_magazines')
      .select('id, label, detected_at')
      .eq('supermarket_id', supermarketId)
      .eq('series_key', seriesKey)
      .is('superseded_by', null)
      .in('status', ['in_review', 'reviewed'])
      .order('detected_at', { ascending: false });
    if (error) throw error;
    const live = data ?? [];
    if (live.length <= 1) continue;

    const newest = live[0] as { id: string; label: string };
    const superseded = await supersedePreviousMagazines(supermarketId, newest.id);
    const paused = await pauseSupersededSeriesMappings(supermarketId, newest.id);
    supersededTotal += superseded.length;
    pausedTotal += paused;
    console.log(
      `  ${supermarketId}/${seriesKey}: kept "${newest.label}", superseded ${superseded.length}, paused ${paused} mapping(s)`,
    );
  }

  console.log(
    `\nPass 2 done: ${supersededTotal} magazine(s) superseded, ${pausedTotal} mapping(s) paused.`,
  );
  console.log(`Undo with: --rollback=${outFile}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('rekey failed:', err);
  process.exit(1);
});
