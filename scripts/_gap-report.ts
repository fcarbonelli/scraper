// TEMP: full (chain,EAN) gap report — client's URL sheet vs the actual export. Delete after.
import ExcelJSmod from 'exceljs';
import { db } from '../src/shared/db.js';
import { writeFileSync } from 'node:fs';

const ExcelJS = (ExcelJSmod as unknown as { default?: typeof import('exceljs') }).default ?? ExcelJSmod;
const SHEET = 'C:\\Users\\fran-\\Downloads\\Excel URL unificado (1).xlsx';
const EXPORT = 'C:\\Users\\fran-\\Downloads\\client-base_2026-07-16.xlsx';
const OUT = 'C:\\Users\\fran-\\Downloads\\productos_faltantes_reporte.csv';

const norm = (s: string): string => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim();
const SUP_ALIAS: Record<string, string> = {
  'ATOMO': 'atomo', 'CALIFORNIA': 'california', 'CARREFOUR': 'carrefour', 'CHANGOMAS': 'changomas',
  'COMODIN': 'comodin', 'CORDIEZ': 'cordiez', 'COTO': 'coto', 'DIA': 'dia', 'DISCO': 'disco',
  'EL ABASTECEDOR': 'el-abastecedor', 'JOSIMAR': 'josimar', 'JUMBO': 'jumbo', 'LA ANONIMA': 'la-anonima',
  'LA COPPE EN CASA': 'lacoopeencasa', 'LA COOPE EN CASA': 'lacoopeencasa', 'LA GALLEGA': 'la-gallega',
  'LA GENOVESA': 'la-genovesa', 'LA REINA': 'la-reina', 'MAMI': 'mami', 'MAXICARREFOUR': 'maxi-carrefour',
  'MAXI CARREFOUR': 'maxi-carrefour', 'MAXICONSUMO': 'maxiconsumo', 'MAXI CONSUMO': 'maxiconsumo',
  'PARODI': 'parodi', 'SUPERTOP': 'supertop', 'VEA': 'vea', 'ROSENTAL': 'rosental', 'MAKRO': 'makro',
  'VITAL': 'vital', 'IMPERIO': 'supertop', 'IMPERIO (SUPERTOP)': 'supertop',
  'LA COOPERATIVA': 'lacoopeencasa', 'COOPERATIVA OBRERA': 'lacoopeencasa',
  'CARREFOUR (SUPERMERCADO MINORISTA)': 'carrefour',
  'SUPER MERCADO LIBRE': 'mercadolibre', 'MERCADO LIBRE': 'mercadolibre',
};

const cs = (v: unknown): string => v == null ? '' : (typeof v === 'object' ? String((v as { result?: unknown; text?: unknown }).result ?? (v as { text?: unknown }).text ?? '') : String(v)).trim();

async function fetchAll<T>(table: string, cols: string, orderBy: string): Promise<T[]> {
  const all: T[] = []; let off = 0;
  for (;;) { const { data, error } = await db.from(table).select(cols).order(orderBy).range(off, off + 999);
    if (error) throw error; const r = (data ?? []) as unknown as T[]; all.push(...r); if (r.length < 1000) break; off += 1000; }
  return all;
}

async function main(): Promise<void> {
  // ---- supermarkets: id ↔ display name ----
  const sups = await fetchAll<{ id: string; is_active: boolean; cadena_display_name: string | null; name: string }>(
    'supermarkets', 'id, is_active, cadena_display_name, name', 'id');
  const displayToId = new Map<string, string>();
  for (const s of sups) { displayToId.set(norm(s.cadena_display_name ?? s.name), s.id); displayToId.set(norm(s.name), s.id); }

  // ---- export: which (supId, EAN) pairs did the client actually receive? ----
  const wbE = new ExcelJS.Workbook(); await wbE.xlsx.readFile(EXPORT);
  const wsE = wbE.worksheets[0]!;
  const hE: string[] = []; wsE.getRow(1).eachCell({ includeEmpty: true }, (c, col) => { hE[col] = cs(c.value); });
  const eanC = hE.findIndex((h) => h && h.toUpperCase() === 'EAN');
  const cadC = hE.findIndex((h) => h && /cadena/i.test(h));
  const exportPairs = new Set<string>();
  const exportEans = new Set<string>();
  for (let r = 2; r <= wsE.rowCount; r++) {
    const ean = cs(wsE.getRow(r).getCell(eanC).value).replace(/\D/g, '');
    const cad = cs(wsE.getRow(r).getCell(cadC).value);
    const sid = displayToId.get(norm(cad));
    if (ean) exportEans.add(ean);
    if (ean && sid) exportPairs.add(`${sid}::${ean}`);
  }
  console.log(`Export: ${exportPairs.size} distinct (chain,EAN) pairs, ${exportEans.size} distinct EANs.`);

  // ---- DB: mappings + product EANs (to explain WHY a pair is missing) ----
  const products = await fetchAll<{ id: string; ean: string | null }>('products', 'id, ean', 'id');
  const pidToEan = new Map<string, string | null>(products.map((p) => [p.id, p.ean]));
  const eanToPids = new Map<string, string[]>();
  for (const p of products) if (p.ean) { const a = eanToPids.get(p.ean) ?? []; a.push(p.id); eanToPids.set(p.ean, a); }
  const maps = await fetchAll<{ supermarket_id: string; product_id: string; is_active: boolean }>(
    'supermarket_products', 'supermarket_id, product_id, is_active', 'product_id');
  const mapByPair = new Map<string, boolean>();          // supId::ean → anyActive (EAN of the mapped product)
  const anyMapAtChainForPid = new Set<string>();          // supId::pid
  for (const m of maps) {
    anyMapAtChainForPid.add(`${m.supermarket_id}::${m.product_id}`);
    const e = pidToEan.get(m.product_id);
    if (e) { const k = `${m.supermarket_id}::${e}`; mapByPair.set(k, (mapByPair.get(k) ?? false) || m.is_active); }
  }

  // ---- client's expectation list (URL sheet) ----
  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(SHEET);
  const ws = wb.getWorksheet('Productos')!;
  interface Row { sup: string; supId: string; ean: string; producto: string; motivo: string; reason: string }
  const missing: Row[] = [];
  const counts = new Map<string, number>();
  let expected = 0;
  for (let r = 2; r <= ws.rowCount; r++) {
    const sup = cs(ws.getRow(r).getCell(1).value);
    const ean = cs(ws.getRow(r).getCell(2).value).replace(/\D/g, '');
    if (!sup || !ean) continue;
    const supId = SUP_ALIAS[norm(sup)];
    if (!supId) continue;
    expected++;
    const pairKey = `${supId}::${ean}`;
    if (exportPairs.has(pairKey)) { counts.set('in_export', (counts.get('in_export') ?? 0) + 1); continue; }

    // Not in export → figure out why.
    const producto = cs(ws.getRow(r).getCell(3).value).replace(/\s+/g, ' ');
    const motivo = cs(ws.getRow(r).getCell(8).value);
    let reason: string;
    const pids = eanToPids.get(ean) ?? [];
    const haveActiveMap = mapByPair.get(pairKey) === true;
    const havePausedMap = mapByPair.get(pairKey) === false;
    const mappedUnderOtherEan = pids.every((pid) => !anyMapAtChainForPid.has(`${supId}::${pid}`))
      && [...anyMapAtChainForPid].some((k) => k.startsWith(`${supId}::`) === false) ? false : undefined;
    // Is this product mapped at this chain at all (by product id), even if under different EAN?
    const mappedByPid = pids.some((pid) => anyMapAtChainForPid.has(`${supId}::${pid}`));

    if (haveActiveMap) reason = 'active_map_but_not_in_export(no published snapshot?)';
    else if (havePausedMap || mappedByPid) reason = 'mapped_but_paused_or_diff_ean';
    else if (!eanToPids.has(ean)) reason = 'ean_not_in_our_db';
    else if (/no se encuentra/i.test(motivo)) reason = 'gap_client_says_not_on_web';
    else if (/sin stock/i.test(motivo)) reason = 'gap_out_of_stock_on_site';
    else reason = 'gap_no_mapping_at_chain';
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
    missing.push({ sup, supId, ean, producto, motivo, reason });
    void mappedUnderOtherEan;
  }

  console.log(`\nClient expects ${expected} (chain,EAN) pairs. Breakdown:`);
  for (const [k, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${k}`);

  const esc = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  writeFileSync(OUT, '\uFEFF' + ['Supermercado,supId,EAN,Producto,Motivo_cliente,Razon_faltante',
    ...missing.map((m) => [m.sup, m.supId, m.ean, m.producto, m.motivo, m.reason].map(esc).join(','))].join('\r\n') + '\r\n', 'utf8');
  console.log(`\nWrote ${missing.length} missing rows → ${OUT}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
