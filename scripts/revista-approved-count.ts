/**
 * Diagnostic: why do fewer approved revista products show in the client export
 * than the total approved count?
 *
 * Counts approved revista_review_items and splits them by:
 *   - current (non-superseded) magazine vs superseded magazine
 *   - active vs paused resulting mapping
 *   - whether they have a run-less revista snapshot dated today (BA)
 *
 * The gap between "total approved" and "in today's export" is usually
 * superseded magazines (carry-forward now only emits the current issue) and/or
 * paused mappings. Read-only. Needs only Supabase env.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/revista-approved-count.ts [--date=YYYY-MM-DD]
 */

import { db } from '../src/shared/db.js';

/* eslint-disable no-console */

function todayBa(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
  }).format(new Date());
}
function baDay(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
  }).format(new Date(iso));
}
function getArg(name: string): string | undefined {
  const pref = `--${name}=`;
  return process.argv.find((a) => a.startsWith(pref))?.slice(pref.length);
}

async function main(): Promise<void> {
  const date = getArg('date') ?? todayBa();
  console.log(`\nREVISTA APPROVED COUNT — dia ${date} (BA)\n`);

  // 1. Magazines: which are current (superseded_by NULL) vs superseded.
  const { data: mags, error: magErr } = await db
    .from('revista_magazines')
    .select('id, supermarket_id, label, status, superseded_by, detected_at');
  if (magErr) throw magErr;
  const magById = new Map((mags ?? []).map((m) => [m.id as string, m]));
  const currentByChain = new Map<string, string>();
  for (const m of mags ?? []) {
    if (m.superseded_by === null) currentByChain.set(m.supermarket_id as string, m.id as string);
  }

  // 2. All approved review items.
  const { data: items, error: itErr } = await db
    .from('revista_review_items')
    .select('id, magazine_id, supermarket_id, status, resulting_supermarket_product_id')
    .eq('status', 'approved');
  if (itErr) throw itErr;
  const approved = items ?? [];

  console.log('== APROBADOS (revista_review_items status=approved) ==');
  console.log(`  Total aprobados:                 ${approved.length}`);

  // Split by current vs superseded magazine.
  let onCurrent = 0;
  let onSuperseded = 0;
  let orphanMag = 0;
  for (const it of approved) {
    const mag = magById.get(it.magazine_id as string);
    if (!mag) {
      orphanMag++;
      continue;
    }
    if (mag.superseded_by === null) onCurrent++;
    else onSuperseded++;
  }
  console.log(`  En folleto ACTUAL:               ${onCurrent}`);
  console.log(`  En folleto SUPERADO:             ${onSuperseded}`);
  if (orphanMag > 0) console.log(`  Con magazine inexistente:        ${orphanMag}`);

  // Distinct resulting mappings.
  const spIds = [
    ...new Set(
      approved
        .map((it) => it.resulting_supermarket_product_id as string | null)
        .filter((x): x is string => Boolean(x)),
    ),
  ];
  console.log(`  Mappings distintos (con snapshot):${spIds.length}`);

  // 3. Active vs paused for those mappings.
  const activeById = new Map<string, boolean>();
  for (let i = 0; i < spIds.length; i += 200) {
    const chunk = spIds.slice(i, i + 200);
    const { data, error } = await db
      .from('supermarket_products')
      .select('id, is_active')
      .in('id', chunk);
    if (error) throw error;
    for (const r of data ?? []) activeById.set(r.id as string, Boolean(r.is_active));
  }
  const activeSpIds = spIds.filter((id) => activeById.get(id));
  const pausedSpIds = spIds.filter((id) => activeById.get(id) === false);
  console.log('\n== MAPPINGS RESULTANTES ==');
  console.log(`  Activos:  ${activeSpIds.length}`);
  console.log(`  Pausados: ${pausedSpIds.length}`);

  // 4. Approved items on the CURRENT magazine with an active mapping = what
  //    carry-forward now emits (the eligible set for today's export).
  const eligibleSp = new Set<string>();
  for (const it of approved) {
    const mag = magById.get(it.magazine_id as string);
    const sp = it.resulting_supermarket_product_id as string | null;
    if (!mag || mag.superseded_by !== null || !sp) continue;
    if (activeById.get(sp)) eligibleSp.add(sp);
  }
  console.log('\n== ELEGIBLES PARA EXPORT (folleto actual + mapping activo) ==');
  console.log(`  Mappings elegibles: ${eligibleSp.size}`);

  // 5. How many actually have a run-less revista snapshot dated `date` today.
  let withSnapToday = 0;
  const missingToday: string[] = [];
  const elig = [...eligibleSp];
  for (let i = 0; i < elig.length; i += 200) {
    const chunk = elig.slice(i, i + 200);
    const { data, error } = await db
      .from('price_snapshots')
      .select('supermarket_product_id, scraped_at, raw_data')
      .in('supermarket_product_id', chunk)
      .is('scrape_run_id', null);
    if (error) throw error;
    const hasToday = new Set<string>();
    for (const r of data ?? []) {
      const src = (r.raw_data as { source?: string } | null)?.source;
      if (src && src !== 'revista' && src !== 'revista-carry-forward') continue;
      if (baDay(r.scraped_at as string) === date) hasToday.add(r.supermarket_product_id as string);
    }
    for (const id of chunk) {
      if (hasToday.has(id)) withSnapToday++;
      else missingToday.push(id);
    }
  }
  console.log(`  Con snapshot de HOY (${date}):   ${withSnapToday}`);
  console.log(`  SIN snapshot de hoy:             ${missingToday.length}`);
  if (missingToday.length > 0) {
    console.log('  (esos aparecerian recien tras correr el carry-forward de hoy)');
  }

  // 6. Per-chain breakdown of approved (current vs superseded).
  console.log('\n== POR CADENA (aprobados: actual / superado) ==');
  const perChain = new Map<string, { cur: number; sup: number }>();
  for (const it of approved) {
    const mag = magById.get(it.magazine_id as string);
    const chain = (it.supermarket_id as string) ?? '(?)';
    const e = perChain.get(chain) ?? { cur: 0, sup: 0 };
    if (mag && mag.superseded_by === null) e.cur++;
    else e.sup++;
    perChain.set(chain, e);
  }
  for (const [c, e] of [...perChain.entries()].sort((a, b) => b[1].cur + b[1].sup - (a[1].cur + a[1].sup))) {
    const cur = currentByChain.get(c);
    const curLabel = cur ? magById.get(cur)?.label ?? cur : '(sin folleto actual)';
    console.log(`  ${c.padEnd(14)} actual=${String(e.cur).padStart(3)} superado=${String(e.sup).padStart(3)}   [folleto actual: ${curLabel}]`);
  }

  console.log('\nRESUMEN:');
  console.log(`  Aprobados totales:            ${approved.length}`);
  console.log(`  En export de hoy (esperado):  ${withSnapToday}`);
  console.log(`  Diferencia:                   ${approved.length - withSnapToday}`);
  console.log('  La diferencia = aprobados en folletos superados + mappings pausados + faltan carry-forward.\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('revista-approved-count failed:', err);
  process.exit(1);
});
