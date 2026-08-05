/**
 * One-off recovery: undo a re-scan that superseded an issue the operator had
 * already curated.
 *
 * Why this exists
 * ---------------
 * On 2026-08-05 the daily check re-processed three flyers that were already in
 * the database (Rosental "Agosto primera quincena", Vital's Folder and Aviso
 * Niñez). Each re-scan superseded the curated row of its series, which paused
 * every mapping whose only approval lived there — 112 products dropped out of
 * the client base — and replaced 150 reviewed items with 60 unreviewed ones.
 * The guard that should have prevented it is fixed separately (decide.ts); this
 * script repairs the rows that already moved.
 *
 * What it considers a "re-scan duplicate"
 * ---------------------------------------
 * A superseded row and the row that superseded it, in the SAME series, with the
 * IDENTICAL label — i.e. the same flyer read twice — where the NEWER row has no
 * approved items. If the newer row has approvals, the two are not
 * interchangeable and a human must decide; the script reports and skips it.
 *
 * The three steps, in this order (the order is not cosmetic)
 * ---------------------------------------------------------
 *   1. deleteMagazine(new)   — cascades its review items, frees its page images
 *                              from Storage, resolves its review alert.
 *   2. un-supersede(old)     — superseded_by / superseded_at back to NULL. The
 *                              only raw write here; there is no endpoint for it.
 *   3. reactivateMagazine(old) — re-activates the mappings and re-emits today's
 *                              price. Must run AFTER step 2: the keep-set in
 *                              pauseRevistaMappingsNotOnCurrent only counts
 *                              magazines with superseded_by IS NULL.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/revistas-undo-reupload.ts                  # dry run
 *   npx tsx --env-file=.env scripts/revistas-undo-reupload.ts --apply
 *   npx tsx --env-file=.env scripts/revistas-undo-reupload.ts --since=2026-08-05
 *   npx tsx --env-file=.env scripts/revistas-undo-reupload.ts --super=rosental
 *   npx tsx --env-file=.env scripts/revistas-undo-reupload.ts --rehash-pubhtml5 [--apply]
 *
 * `--apply` writes a rollback file FIRST containing the supersede pointers it is
 * about to clear and a full dump of every row and review item it is about to
 * delete — deleting a magazine is not reversible, so the data has to survive
 * somewhere before it goes.
 */

import { writeFileSync } from 'node:fs';
import { db } from '../src/shared/db.js';
import { deleteMagazine, reactivateMagazine } from '../src/revistas/approve.js';
import { loadRevistaSupermarkets } from '../src/revistas/pipeline.js';
import { discoverCandidates } from '../src/revistas/sources.js';

/* eslint-disable no-console */

interface MagRow {
  id: string;
  supermarket_id: string;
  label: string;
  series_key: string | null;
  status: string;
  content_hash: string;
  file_size: number | null;
  page_count: number;
  source_url: string | null;
  detected_at: string;
  superseded_by: string | null;
  superseded_at: string | null;
  carry_active: boolean;
}

interface Pair {
  old: MagRow;
  neu: MagRow;
  oldItems: number;
  oldApproved: number;
  newItems: number;
  newApproved: number;
  /** Mappings of the old row's approvals that are currently paused. */
  pausedMappings: string[];
}

function getArg(name: string): string | undefined {
  const pref = `--${name}=`;
  return process.argv.find((a) => a.startsWith(pref))?.slice(pref.length);
}

async function countItems(magazineId: string, status?: string): Promise<number> {
  let q = db
    .from('revista_review_items')
    .select('id', { count: 'exact', head: true })
    .eq('magazine_id', magazineId);
  if (status) q = q.eq('status', status);
  const { count, error } = await q;
  if (error) throw error;
  return count ?? 0;
}

/** Mapping ids the old row's approvals point at, split by is_active. */
async function approvedMappings(magazineId: string): Promise<{ active: string[]; paused: string[] }> {
  const { data, error } = await db
    .from('revista_review_items')
    .select('resulting_supermarket_product_id')
    .eq('magazine_id', magazineId)
    .eq('status', 'approved')
    .not('resulting_supermarket_product_id', 'is', null);
  if (error) throw error;
  const ids = [
    ...new Set(
      (data ?? [])
        .map((r) => r.resulting_supermarket_product_id as string | null)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  if (ids.length === 0) return { active: [], paused: [] };

  const { data: sp, error: spErr } = await db
    .from('supermarket_products')
    .select('id, is_active')
    .in('id', ids);
  if (spErr) throw spErr;
  const active: string[] = [];
  const paused: string[] = [];
  for (const row of sp ?? []) {
    (row.is_active ? active : paused).push(row.id as string);
  }
  return { active, paused };
}

async function findPairs(since: string, supermarketId?: string): Promise<{ pairs: Pair[]; skipped: string[] }> {
  let q = db
    .from('revista_magazines')
    .select(
      'id, supermarket_id, label, series_key, status, content_hash, file_size, page_count, source_url, detected_at, superseded_by, superseded_at, carry_active',
    )
    .not('superseded_by', 'is', null)
    .gte('superseded_at', since);
  if (supermarketId) q = q.eq('supermarket_id', supermarketId);
  const { data, error } = await q.order('superseded_at', { ascending: true });
  if (error) throw error;
  const olds = (data ?? []) as MagRow[];

  const pairs: Pair[] = [];
  const skipped: string[] = [];
  for (const old of olds) {
    const { data: newData, error: newErr } = await db
      .from('revista_magazines')
      .select(
        'id, supermarket_id, label, series_key, status, content_hash, file_size, page_count, source_url, detected_at, superseded_by, superseded_at, carry_active',
      )
      .eq('id', old.superseded_by as string)
      .maybeSingle();
    if (newErr) throw newErr;
    const neu = newData as MagRow | null;
    if (!neu) {
      skipped.push(`${old.supermarket_id} "${old.label}" — la fila que la superó ya no existe`);
      continue;
    }
    if (neu.label !== old.label) {
      // Different label = genuinely a new edition. Not our case.
      continue;
    }
    const newApproved = await countItems(neu.id, 'approved');
    const oldApproved = await countItems(old.id, 'approved');
    const oldItems = await countItems(old.id);
    const newItems = await countItems(neu.id);
    if (newApproved > 0) {
      skipped.push(
        `${old.supermarket_id} "${old.label}" — la fila nueva ya tiene ${newApproved} aprobado(s); decidilo a mano`,
      );
      continue;
    }
    const { paused } = await approvedMappings(old.id);
    pairs.push({ old, neu, oldItems, oldApproved, newItems, newApproved, pausedMappings: paused });
  }
  return { pairs, skipped };
}

/** Full dump of a magazine + its items, so --apply's delete is not a one-way door. */
async function dumpMagazine(magazineId: string): Promise<unknown> {
  const { data: mag, error } = await db
    .from('revista_magazines')
    .select('*')
    .eq('id', magazineId)
    .single();
  if (error) throw error;
  const { data: items, error: itemsErr } = await db
    .from('revista_review_items')
    .select('*')
    .eq('magazine_id', magazineId);
  if (itemsErr) throw itemsErr;
  return { magazine: mag, items: items ?? [] };
}

async function currentPerSeries(supermarketIds: string[]): Promise<void> {
  const { data, error } = await db
    .from('revista_magazines')
    .select('supermarket_id, series_key, label, detected_at')
    .in('supermarket_id', supermarketIds)
    .is('superseded_by', null)
    .in('status', ['in_review', 'reviewed'])
    .order('supermarket_id');
  if (error) throw error;
  const bySeries = new Map<string, { label: string; detected: string }[]>();
  for (const r of data ?? []) {
    const key = `${r.supermarket_id}/${r.series_key ?? 'default'}`;
    const list = bySeries.get(key) ?? [];
    list.push({ label: r.label as string, detected: (r.detected_at as string).slice(0, 16) });
    bySeries.set(key, list);
  }
  console.log('\nVIGENTES POR SERIE (debe haber exactamente una por serie):');
  for (const [key, rows] of [...bySeries.entries()].sort()) {
    const flag = rows.length > 1 ? '  ⚠️ DUPLICADA' : '';
    console.log(`  ${key}: ${rows.length}${flag}`);
    for (const r of rows) console.log(`      "${r.label}" (${r.detected})`);
  }
}

/**
 * Re-point the stored `content_hash` of each pubhtml5 chain's current issue at
 * what discovery computes TODAY.
 *
 * Only meaningful once the content-only fingerprint of `sources.ts` is
 * deployed: run it against the old formula and the server would still miss.
 * Cosmetic either way — with the guard in decide.ts the worst case is a skip —
 * but it turns the daily state from "re-subida salteada" into a plain hash hit.
 *
 * Refuses to touch a row whose label or page count disagrees with the book on
 * the site: that is a different issue, and re-pointing the hash would hide it.
 */
async function rehashPubhtml5(apply: boolean): Promise<void> {
  console.log('\nRE-HASH pubhtml5 (fórmula solo-contenido)\n');
  const supers = await loadRevistaSupermarkets();
  for (const sm of supers.filter((s) => s.strategy.strategy === 'pubhtml5')) {
    const candidates = await discoverCandidates(sm.strategy);
    for (const c of candidates) {
      const { data, error } = await db
        .from('revista_magazines')
        .select('id, label, page_count, content_hash')
        .eq('supermarket_id', sm.id)
        .eq('series_key', c.seriesKey)
        .is('superseded_by', null)
        .in('status', ['in_review', 'reviewed'])
        .order('detected_at', { ascending: false })
        .limit(1);
      if (error) throw error;
      const row = data?.[0];
      if (!row) {
        console.log(`  ${sm.id}: no hay fila vigente para la serie "${c.seriesKey}" — nada que re-hashear`);
        continue;
      }
      if (row.label !== c.label || (c.pageCount != null && row.page_count !== c.pageCount)) {
        console.log(
          `  ⚠️  ${sm.id}: la fila vigente ("${row.label}", ${row.page_count} págs) no coincide con el ` +
            `libro publicado ("${c.label}", ${c.pageCount} págs) — NO se toca, es otra edición`,
        );
        continue;
      }
      if (row.content_hash === c.hash) {
        console.log(`  ${sm.id}: el hash ya coincide (${c.hash}) — nada que hacer`);
        continue;
      }
      console.log(`  ${sm.id}: "${row.label}" ${row.content_hash} → ${c.hash}`);
      if (apply) {
        const { error: updErr } = await db
          .from('revista_magazines')
          .update({ content_hash: c.hash })
          .eq('id', row.id);
        if (updErr) throw updErr;
      }
    }
  }
  console.log(apply ? '\nRe-hash aplicado.\n' : '\nDRY-RUN: no se escribió nada.\n');
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const since = getArg('since') ?? '2026-08-05';
  const supermarketId = getArg('super');

  if (process.argv.includes('--rehash-pubhtml5')) {
    await rehashPubhtml5(apply);
    process.exit(0);
  }

  console.log('\nUNDO RE-SUBIDA — restaurar folletos curados que un re-escaneo superó');
  console.log(`modo: ${apply ? 'APPLY (escribe en la base)' : 'DRY-RUN (no escribe nada)'}`);
  console.log(`superadas desde: ${since}${supermarketId ? ` | cadena: ${supermarketId}` : ''}\n`);

  const { pairs, skipped } = await findPairs(since, supermarketId);

  for (const s of skipped) console.log(`  ⚠️  salteada: ${s}`);
  if (pairs.length === 0) {
    console.log('\nNo hay ningún par (superada + superadora con el MISMO label y sin aprobados). Nada que hacer.\n');
    process.exit(0);
  }

  console.log(`\n${pairs.length} par(es) a restaurar:\n`);
  let totalPaused = 0;
  for (const p of pairs) {
    totalPaused += p.pausedMappings.length;
    console.log(`  ${p.old.supermarket_id} / serie=${p.old.series_key ?? 'default'} — "${p.old.label}"`);
    console.log(
      `    restaurar: ${p.old.id} (${p.old.detected_at.slice(0, 16)}, ${p.old.status}, ` +
        `${p.oldItems} ítems, ${p.oldApproved} aprobados, ${p.pausedMappings.length} mappings pausados)`,
    );
    console.log(
      `    borrar:    ${p.neu.id} (${p.neu.detected_at.slice(0, 16)}, ${p.neu.status}, ` +
        `${p.newItems} ítems, ${p.newApproved} aprobados, ${p.neu.page_count} imágenes)`,
    );
  }
  console.log(`\nTotal de mappings a reactivar: ${totalPaused}`);

  if (!apply) {
    console.log('\nDRY-RUN: no se escribió nada. Volvé a correr con --apply.\n');
    await currentPerSeries([...new Set(pairs.map((p) => p.old.supermarket_id))]);
    process.exit(0);
  }

  // Rollback FIRST: deleteMagazine cascades its items and drops its page images.
  const rollback = {
    created_at: new Date().toISOString(),
    note: 'revistas-undo-reupload: filas des-superadas + volcado completo de las filas borradas',
    restored: pairs.map((p) => ({
      id: p.old.id,
      superseded_by: p.old.superseded_by,
      superseded_at: p.old.superseded_at,
    })),
    deleted: [] as unknown[],
    reactivated_mappings: pairs.flatMap((p) => p.pausedMappings),
  };
  for (const p of pairs) rollback.deleted.push(await dumpMagazine(p.neu.id));

  const file = `revista-undo-reupload-rollback-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(file, JSON.stringify(rollback, null, 2), 'utf8');
  console.log(`\nRollback escrito en ${file}\n`);

  for (const p of pairs) {
    console.log(`→ ${p.old.supermarket_id} "${p.old.label}"`);

    const del = await deleteMagazine(p.neu.id);
    console.log(
      `   1. borrada la fila nueva: ${del.deletedItems} ítem(s), ${del.deletedImages} imagen(es), ` +
        `${del.pausedMappings} mapping(s) pausados, ${del.purgedToday} snapshot(s) de hoy purgados`,
    );

    const { error } = await db
      .from('revista_magazines')
      .update({ superseded_by: null, superseded_at: null })
      .eq('id', p.old.id);
    if (error) throw error;
    console.log('   2. des-superada la fila curada (vuelve a ser la vigente de su serie)');

    const react = await reactivateMagazine(p.old.id);
    console.log(`   3. reactivada: ${react.affectedMappings} precio(s) de hoy re-emitidos`);

    const { paused: stillPaused } = await approvedMappings(p.old.id);
    if (stillPaused.length > 0) {
      console.log(`   ⚠️  quedan ${stillPaused.length} mapping(s) pausados: ${stillPaused.slice(0, 5).join(', ')}…`);
    }
  }

  await currentPerSeries([...new Set(pairs.map((p) => p.old.supermarket_id))]);
  console.log('\nListo.\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('revistas-undo-reupload falló:', err);
  process.exit(1);
});
