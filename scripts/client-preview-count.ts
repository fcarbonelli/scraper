/**
 * Diagnostic: count what the client actually receives for a given BA day.
 *
 * Answers "why does the front show N products?" by breaking down the
 * client_base export into: raw rows, unique products after dedup (same rule as
 * the revista duplicate control: offer wins, else newest scraped_at, else
 * highest ID), and — separately — how many mappings are currently paused
 * (is_active=false) so we can tell if some got UN-paused.
 *
 * Read-only. Needs only Supabase env.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/client-preview-count.ts [--date=YYYY-MM-DD]
 */

import { db } from '../src/shared/db.js';
import { fetchAllPages } from '../src/shared/db.js';
import { getCatalogEans } from '../src/shared/catalog.js';

/* eslint-disable no-console */

function todayBa(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
  }).format(new Date());
}

function getArg(name: string): string | undefined {
  const pref = `--${name}=`;
  return process.argv.find((a) => a.startsWith(pref))?.slice(pref.length);
}

interface ClientRow {
  ID: number | string;
  Cadena: string | null;
  EAN: string | null;
  Estado: string | null;
  Precio_Regular: number | string | null;
  Precio_c_Oferta_1: number | string | null;
  Promocion_1: string | null;
  Fecha_Actualizacion: string;
  Fecha_Relevamiento: string;
}

const hasOffer = (r: ClientRow): boolean =>
  Number(r.Precio_c_Oferta_1) > 0 || (r.Promocion_1?.trim() ?? '') !== '';

/** Pick the winner among duplicate rows: offer wins, else newest, else highest ID. */
function pickWinner(rows: ClientRow[]): ClientRow {
  return [...rows].sort((a, b) => {
    const off = Number(hasOffer(b)) - Number(hasOffer(a));
    if (off !== 0) return off;
    const t = b.Fecha_Actualizacion.localeCompare(a.Fecha_Actualizacion);
    if (t !== 0) return t;
    return Number(b.ID) - Number(a.ID);
  })[0]!;
}

async function main(): Promise<void> {
  const date = getArg('date') ?? todayBa();
  const chain = getArg('chain'); // e.g. "MAXI CONSUMO" (Cadena display name)
  console.log(`\nCLIENT PREVIEW COUNT — Fecha_Relevamiento = ${date} (BA)${chain ? ` — Cadena = ${chain}` : ''}\n`);

  // 1. All client_base rows for the day (what /v1/data/pricing returns raw).
  const rows = await fetchAllPages<ClientRow>((from, to) => {
    let q = db
      .from('client_base')
      .select(
        'ID, Cadena, EAN, Estado, Precio_Regular, Precio_c_Oferta_1, Promocion_1, Fecha_Actualizacion, Fecha_Relevamiento',
      )
      .eq('Fecha_Relevamiento', date);
    if (chain) q = q.eq('Cadena', chain.toUpperCase());
    return q.order('ID', { ascending: false }).range(from, to);
  });

  if (rows.length === 0) {
    console.log('No hay filas en client_base para esa fecha.');
    console.log('(Probá otra fecha con --date=YYYY-MM-DD, o revisá que el carry-forward/scrape haya corrido.)');
    process.exit(0);
  }

  // 2. Dedup by (Cadena, EAN, Fecha_Relevamiento) — same key the front uses.
  const groups = new Map<string, ClientRow[]>();
  for (const r of rows) {
    const key = `${r.Cadena}|${r.EAN}|${r.Fecha_Relevamiento}`;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  const uniqueRows = [...groups.values()].map(pickWinner);

  const dupGroups = [...groups.values()].filter((g) => g.length > 1);
  const dupExtraRows = dupGroups.reduce((n, g) => n + (g.length - 1), 0);

  // 3. Totals.
  console.log('== TOTALES ==');
  console.log(`  Filas crudas (lo que devuelve /pricing):     ${rows.length}`);
  console.log(`  Productos unicos tras dedup:                  ${uniqueRows.length}`);
  console.log(`  Grupos con duplicados:                        ${dupGroups.length}`);
  console.log(`  Filas duplicadas de mas (crudas - unicas):    ${dupExtraRows}`);

  // 4. Breakdown per chain (raw vs unique).
  const perChain = new Map<string, { raw: number; unique: number }>();
  for (const r of rows) {
    const c = r.Cadena ?? '(sin cadena)';
    const e = perChain.get(c) ?? { raw: 0, unique: 0 };
    e.raw++;
    perChain.set(c, e);
  }
  for (const u of uniqueRows) {
    const c = u.Cadena ?? '(sin cadena)';
    const e = perChain.get(c) ?? { raw: 0, unique: 0 };
    e.unique++;
    perChain.set(c, e);
  }
  console.log('\n== POR CADENA (crudo -> unico) ==');
  for (const [c, e] of [...perChain.entries()].sort((a, b) => b[1].unique - a[1].unique)) {
    const flag = e.raw !== e.unique ? `  (${e.raw - e.unique} dup)` : '';
    console.log(`  ${c.padEnd(24)} ${String(e.raw).padStart(4)} -> ${String(e.unique).padStart(4)}${flag}`);
  }

  // 5. Estado breakdown (unique rows) — out_of_stock/delisted still count as a product.
  const perEstado = new Map<string, number>();
  for (const u of uniqueRows) {
    const s = u.Estado ?? '(null)';
    perEstado.set(s, (perEstado.get(s) ?? 0) + 1);
  }
  console.log('\n== ESTADO (productos unicos) ==');
  const okCount = perEstado.get('ok') ?? 0;
  for (const [s, n] of [...perEstado.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${s.padEnd(16)} ${n}`);
  }
  console.log(`  --> solo 'ok' (si el front filtra estados): ${okCount}`);

  // 5b. EAN analysis — front may dedup by EAN or drop null EAN / null price.
  const eanCounts = new Map<string, number>();
  let nullEan = 0;
  let nullPrice = 0;
  for (const u of uniqueRows) {
    const ean = (u.EAN ?? '').trim();
    if (!ean) nullEan++;
    else eanCounts.set(ean, (eanCounts.get(ean) ?? 0) + 1);
    if (u.Precio_Regular === null || u.Precio_Regular === '' || Number(u.Precio_Regular) === 0) nullPrice++;
  }
  const distinctEan = eanCounts.size;
  const eanRepeated = [...eanCounts.entries()].filter(([, n]) => n > 1);
  console.log('\n== EAN (sobre productos unicos) ==');
  console.log(`  EAN distintos:                 ${distinctEan}`);
  console.log(`  Productos con EAN vacio/null:  ${nullEan}`);
  console.log(`  Productos con precio 0/vacio:  ${nullPrice}`);
  console.log(`  EAN que aparecen en 2+ prod.:  ${eanRepeated.length}`);
  if (eanRepeated.length > 0 && eanRepeated.length <= 20) {
    for (const [ean, n] of eanRepeated) console.log(`    ${ean}  x${n}`);
  }
  console.log(`  --> si el front cuenta EAN distintos: ${distinctEan}`);

  // 5c. Cross against the client's official catalog (211 target EANs + extras).
  //     If the front filters to catalog EANs, this is what it would show.
  const catalog = await getCatalogEans();
  let inCatalog = 0;
  let outOfCatalog = 0;
  const outSample: string[] = [];
  for (const u of uniqueRows) {
    const ean = (u.EAN ?? '').trim();
    if (ean && catalog.has(ean)) inCatalog++;
    else {
      outOfCatalog++;
      if (outSample.length < 15) outSample.push(ean || '(vacio)');
    }
  }
  console.log('\n== VS CATALOGO CLIENTE ==');
  console.log(`  Catalogo total (EAN target):   ${catalog.size}`);
  console.log(`  Productos EN catalogo:         ${inCatalog}`);
  console.log(`  Productos FUERA de catalogo:   ${outOfCatalog}`);
  console.log(`  --> si el front filtra al catalogo cliente: ${inCatalog}`);
  if (outSample.length > 0) {
    console.log('  EAN fuera de catalogo (muestra):');
    for (const e of outSample) console.log(`    ${e}`);
  }

  // 6. Paused mappings right now (to detect "despausaron algunos").
  const { data: mappings, error } = await db
    .from('supermarket_products')
    .select('supermarket_id, is_active');
  if (error) throw error;
  let active = 0;
  let paused = 0;
  const pausedByChain = new Map<string, number>();
  for (const m of mappings ?? []) {
    if (m.is_active) active++;
    else {
      paused++;
      pausedByChain.set(m.supermarket_id, (pausedByChain.get(m.supermarket_id) ?? 0) + 1);
    }
  }
  console.log('\n== MAPPINGS (estado actual, todas las fechas) ==');
  console.log(`  Activos: ${active}   Pausados: ${paused}`);
  if (pausedByChain.size > 0) {
    console.log('  Pausados por cadena:');
    for (const [c, n] of [...pausedByChain.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${c.padEnd(24)} ${n}`);
    }
  }

  console.log('\nNota: client_base YA excluye pausados. Si el numero unico crecio,');
  console.log('probablemente se re-activo (despauso) alguna mapping o entraron datos nuevos hoy.\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('client-preview-count failed:', err);
  process.exit(1);
});
