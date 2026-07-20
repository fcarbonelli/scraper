// TEMP: split the 189 actionable gaps into "truly absent → add via URL" vs "already in scraper". Delete after.
import ExcelJSmod from 'exceljs';
import { db } from '../src/shared/db.js';
import { writeFileSync } from 'node:fs';

const ExcelJS = (ExcelJSmod as unknown as { default?: typeof import('exceljs') }).default ?? ExcelJSmod;
const SHEET = 'C:\\Users\\fran-\\Downloads\\Excel URL unificado (1).xlsx';
const EXPORT = 'C:\\Users\\fran-\\Downloads\\client-base_2026-07-16.xlsx';
const OUT_ADD_CSV = 'C:\\Users\\fran-\\Downloads\\faltantes_para_agregar.csv';
const OUT_ADD_TXT = 'C:\\Users\\fran-\\OneDrive\\Escritorio\\Proyects\\Mega\\scraper-prod\\scraper\\scripts\\_add-missing.txt';
const OUT_HAVE_CSV = 'C:\\Users\\fran-\\Downloads\\faltantes_ya_en_scraper.csv';

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
function extractUrl(cell: { value: unknown; hyperlink?: string }): string {
  const v = cell.value as unknown; let u = '';
  if (v && typeof v === 'object') { const o = v as Record<string, unknown>; u = String(o.hyperlink ?? o.text ?? '').trim(); }
  else if (typeof v === 'string') u = v.trim();
  if (!u && cell.hyperlink) u = String(cell.hyperlink).trim();
  return /^https?:\/\//i.test(u) ? u : '';
}
function normUrl(u: string): string {
  try { const x = new URL(u); return (x.host + decodeURIComponent(x.pathname)).toLowerCase().replace(/\/+$/, ''); }
  catch { return u.toLowerCase().replace(/\/+$/, ''); }
}

async function fetchAll<T>(table: string, cols: string, orderBy: string): Promise<T[]> {
  const all: T[] = []; let off = 0;
  for (;;) { const { data, error } = await db.from(table).select(cols).order(orderBy).range(off, off + 999);
    if (error) throw error; const r = (data ?? []) as unknown as T[]; all.push(...r); if (r.length < 1000) break; off += 1000; }
  return all;
}

async function main(): Promise<void> {
  const sups = await fetchAll<{ id: string; cadena_display_name: string | null; name: string }>('supermarkets', 'id, cadena_display_name, name', 'id');
  const displayToId = new Map<string, string>();
  for (const s of sups) { displayToId.set(norm(s.cadena_display_name ?? s.name), s.id); displayToId.set(norm(s.name), s.id); }

  // Export pairs (supId::ean) delivered today.
  const wbE = new ExcelJS.Workbook(); await wbE.xlsx.readFile(EXPORT);
  const wsE = wbE.worksheets[0]!; const hE: string[] = [];
  wsE.getRow(1).eachCell({ includeEmpty: true }, (c, col) => { hE[col] = cs(c.value); });
  const eanC = hE.findIndex((h) => h && h.toUpperCase() === 'EAN'); const cadC = hE.findIndex((h) => h && /cadena/i.test(h));
  const exportPairs = new Set<string>();
  for (let r = 2; r <= wsE.rowCount; r++) {
    const ean = cs(wsE.getRow(r).getCell(eanC).value).replace(/\D/g, ''); const sid = displayToId.get(norm(cs(wsE.getRow(r).getCell(cadC).value)));
    if (ean && sid) exportPairs.add(`${sid}::${ean}`);
  }

  // DB: products + mappings. Build per-chain normalized-URL set + product-id presence per chain.
  const products = await fetchAll<{ id: string; ean: string | null }>('products', 'id, ean', 'id');
  const pidToEan = new Map(products.map((p) => [p.id, p.ean]));
  const eanToPids = new Map<string, string[]>();
  for (const p of products) if (p.ean) { const a = eanToPids.get(p.ean) ?? []; a.push(p.id); eanToPids.set(p.ean, a); }
  const maps = await fetchAll<{ supermarket_id: string; product_id: string; is_active: boolean; external_url: string | null }>(
    'supermarket_products', 'supermarket_id, product_id, is_active, external_url', 'product_id');
  const urlAtChain = new Map<string, { active: boolean }>();   // supId::normUrl
  const pidAtChain = new Set<string>();                        // supId::pid
  const eanActiveAtChain = new Map<string, boolean>();         // supId::ean -> anyActive
  for (const m of maps) {
    pidAtChain.add(`${m.supermarket_id}::${m.product_id}`);
    if (m.external_url) urlAtChain.set(`${m.supermarket_id}::${normUrl(m.external_url)}`, { active: m.is_active });
    const e = pidToEan.get(m.product_id);
    if (e) { const k = `${m.supermarket_id}::${e}`; eanActiveAtChain.set(k, (eanActiveAtChain.get(k) ?? false) || m.is_active); }
  }

  // Walk the sheet, isolate the actionable set (in the client list, NOT in export, and NOT client-flagged unavailable).
  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(SHEET);
  const ws = wb.getWorksheet('Productos')!;
  interface Row { sup: string; supId: string; ean: string; producto: string; url: string; verdict: string; detail: string }
  const add: Row[] = []; const have: Row[] = []; const noUrl: Row[] = [];

  for (let r = 2; r <= ws.rowCount; r++) {
    const sup = cs(ws.getRow(r).getCell(1).value); const ean = cs(ws.getRow(r).getCell(2).value).replace(/\D/g, '');
    if (!sup || !ean) continue; const supId = SUP_ALIAS[norm(sup)]; if (!supId) continue;
    const pairKey = `${supId}::${ean}`;
    if (exportPairs.has(pairKey)) continue;                       // already delivered
    const motivo = cs(ws.getRow(r).getCell(8).value);
    if (/no se encuentra|sin stock/i.test(motivo)) continue;      // client says not available — skip
    if (!eanToPids.has(ean)) continue;                            // ean_not_in_db (1) — skip here
    // This is one of the ~189 "ya sumado but missing" actionable rows.
    const producto = cs(ws.getRow(r).getCell(3).value).replace(/\s+/g, ' ');
    const url = extractUrl(ws.getRow(r).getCell(7) as unknown as { value: unknown; hyperlink?: string });

    // Do we already have this exact-EAN mapping (any state)?
    const exactEanState = eanActiveAtChain.get(pairKey);
    // Do we already have a mapping matching the client's URL?
    const byUrl = url ? urlAtChain.get(`${supId}::${normUrl(url)}`) : undefined;
    // Do we have the same product (by EAN's product-id) at this chain under any EAN?
    const pids = eanToPids.get(ean) ?? [];
    const samePidHere = pids.some((pid) => pidAtChain.has(`${supId}::${pid}`));

    if (byUrl) { have.push({ sup, supId, ean, producto, url, verdict: 'have_url', detail: `URL ya mapeada (${byUrl.active ? 'activa' : 'pausada'})` }); }
    else if (exactEanState !== undefined) { have.push({ sup, supId, ean, producto, url, verdict: 'have_ean', detail: `EAN ya mapeado (${exactEanState ? 'activa' : 'pausada'})` }); }
    else if (samePidHere) { have.push({ sup, supId, ean, producto, url, verdict: 'have_pid', detail: 'mismo producto mapeado bajo otro EAN' }); }
    else if (url) { add.push({ sup, supId, ean, producto, url, verdict: 'ADD', detail: 'no está en el scraper — ingerir por URL' }); }
    else { noUrl.push({ sup, supId, ean, producto, url, verdict: 'no_url', detail: 'falta pero sin URL en la planilla' }); }
  }

  console.log(`Actionable ("ya sumado" but not in export): ${add.length + have.length + noUrl.length}`);
  console.log(`  ADD (truly absent, has URL → ingest):   ${add.length}`);
  console.log(`  ALREADY IN SCRAPER (skip, no reactivate):${have.length}`);
  console.log(`  NO URL (can't auto-add):                ${noUrl.length}`);
  const byChain = new Map<string, number>();
  for (const a of add) byChain.set(a.sup, (byChain.get(a.sup) ?? 0) + 1);
  console.log('\nADD by chain:');
  for (const [c, n] of [...byChain.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${c.padEnd(22)} ${n}`);

  const haveByReason = new Map<string, number>();
  for (const h of have) haveByReason.set(h.detail, (haveByReason.get(h.detail) ?? 0) + 1);
  console.log('\nALREADY IN SCRAPER breakdown:');
  for (const [k, n] of [...haveByReason.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);

  const esc = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  writeFileSync(OUT_ADD_CSV, '\uFEFF' + ['Supermercado,supId,EAN,Producto,URL', ...add.map((a) => [a.sup, a.supId, a.ean, a.producto, a.url].map(esc).join(','))].join('\r\n') + '\r\n', 'utf8');
  writeFileSync(OUT_HAVE_CSV, '\uFEFF' + ['Supermercado,supId,EAN,Producto,Estado,URL', ...have.map((h) => [h.sup, h.supId, h.ean, h.producto, h.detail, h.url].map(esc).join(','))].join('\r\n') + '\r\n', 'utf8');
  writeFileSync(OUT_ADD_TXT, '# ' + add.length + ' productos ausentes del scraper, con URL — ingest via scrape:bulk\n' + add.map((a) => a.url).join('\n') + '\n', 'utf8');
  console.log(`\nWrote ADD list → ${OUT_ADD_CSV}  (+ url list ${OUT_ADD_TXT})`);
  console.log(`Wrote ALREADY-IN-SCRAPER list → ${OUT_HAVE_CSV}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
