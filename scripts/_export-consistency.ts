// TEMP: export consistency audit — non-client EANs in the export, missing client EANs, + deep-dive on 2 cases. Delete after.
import ExcelJSmod from 'exceljs';
import { db } from '../src/shared/db.js';

const ExcelJS = (ExcelJSmod as unknown as { default?: typeof import('exceljs') }).default ?? ExcelJSmod;
const SHEET = 'C:\\Users\\fran-\\Downloads\\Excel URL unificado (1).xlsx';
const EXPORT = 'C:\\Users\\fran-\\Downloads\\client-base_2026-07-16.xlsx';

const norm = (s: string): string => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim();
const cs = (v: unknown): string => v == null ? '' : (typeof v === 'object' ? String((v as { result?: unknown; text?: unknown }).result ?? (v as { text?: unknown }).text ?? '') : String(v)).trim();
function extractUrl(cell: { value: unknown; hyperlink?: string }): string {
  const v = cell.value as unknown; let u = '';
  if (v && typeof v === 'object') { const o = v as Record<string, unknown>; u = String(o.hyperlink ?? o.text ?? '').trim(); }
  else if (typeof v === 'string') u = v.trim();
  if (!u && cell.hyperlink) u = String(cell.hyperlink).trim();
  return /^https?:\/\//i.test(u) ? u : '';
}
function normUrl(u: string): string { try { const x = new URL(u); return (x.host + decodeURIComponent(x.pathname)).toLowerCase().replace(/\/+$/, ''); } catch { return u.toLowerCase(); } }
const SUP_ALIAS: Record<string, string> = {
  'ATOMO': 'atomo', 'CALIFORNIA': 'california', 'CARREFOUR': 'carrefour', 'CHANGOMAS': 'changomas', 'COMODIN': 'comodin',
  'CORDIEZ': 'cordiez', 'COTO': 'coto', 'DIA': 'dia', 'DISCO': 'disco', 'EL ABASTECEDOR': 'el-abastecedor', 'JOSIMAR': 'josimar',
  'JUMBO': 'jumbo', 'LA ANONIMA': 'la-anonima', 'LA COOPERATIVA': 'lacoopeencasa', 'LA GALLEGA': 'la-gallega', 'LA GENOVESA': 'la-genovesa',
  'LA REINA': 'la-reina', 'MAMI': 'mami', 'MAXI CARREFOUR': 'maxi-carrefour', 'MAXICONSUMO': 'maxiconsumo', 'PARODI': 'parodi',
  'IMPERIO': 'supertop', 'IMPERIO (SUPERTOP)': 'supertop', 'VEA': 'vea', 'CARREFOUR (SUPERMERCADO MINORISTA)': 'carrefour',
};
async function fetchAll<T>(table: string, cols: string, orderBy: string): Promise<T[]> {
  const all: T[] = []; let off = 0;
  for (;;) { const { data, error } = await db.from(table).select(cols).order(orderBy).range(off, off + 999);
    if (error) throw error; const r = (data ?? []) as unknown as T[]; all.push(...r); if (r.length < 1000) break; off += 1000; }
  return all;
}

async function main(): Promise<void> {
  // client master EANs + per-(supId,ean) URL
  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(SHEET);
  const ws = wb.getWorksheet('Productos')!;
  const clientEans = new Set<string>();
  const cellUrl = new Map<string, string>(); // supId::ean -> url
  for (let r = 2; r <= ws.rowCount; r++) {
    const ean = cs(ws.getRow(r).getCell(2).value).replace(/\D/g, ''); if (ean) clientEans.add(ean);
    const supId = SUP_ALIAS[norm(cs(ws.getRow(r).getCell(1).value))];
    const url = extractUrl(ws.getRow(r).getCell(7) as unknown as { value: unknown; hyperlink?: string });
    if (supId && ean && url) cellUrl.set(`${supId}::${ean}`, url);
  }

  // supermarkets display→id
  const sups = await fetchAll<{ id: string; cadena_display_name: string | null; name: string }>('supermarkets', 'id, cadena_display_name, name', 'id');
  const displayToId = new Map<string, string>();
  for (const s of sups) { displayToId.set(norm(s.cadena_display_name ?? s.name), s.id); displayToId.set(norm(s.name), s.id); }

  // export
  const wbE = new ExcelJS.Workbook(); await wbE.xlsx.readFile(EXPORT);
  const wsE = wbE.worksheets[0]!; const hE: string[] = [];
  wsE.getRow(1).eachCell({ includeEmpty: true }, (c, col) => { hE[col] = cs(c.value); });
  const eanC = hE.findIndex((h) => h && h.toUpperCase() === 'EAN'); const cadC = hE.findIndex((h) => h && /cadena/i.test(h));
  const descC = hE.findIndex((h) => h && /desc.*sku|sku.*sitio/i.test(h));
  const exportEans = new Set<string>();
  const nonClientRows: { cadena: string; ean: string; desc: string }[] = [];
  for (let r = 2; r <= wsE.rowCount; r++) {
    const ean = cs(wsE.getRow(r).getCell(eanC).value).replace(/\D/g, ''); if (!ean) continue;
    exportEans.add(ean);
    if (!clientEans.has(ean)) nonClientRows.push({ cadena: cs(wsE.getRow(r).getCell(cadC).value), ean, desc: descC > 0 ? cs(wsE.getRow(r).getCell(descC).value) : '' });
  }

  console.log(`Client master EANs: ${clientEans.size}   Export distinct EANs: ${exportEans.size}`);
  console.log(`\n=== Q1: NON-CLIENT EANs present in the export (inconsistency) ===`);
  const nonClientEans = new Set(nonClientRows.map((r) => r.ean));
  console.log(`Distinct non-client EANs in export: ${nonClientEans.size}   (rows: ${nonClientRows.length})`);
  for (const r of nonClientRows.slice(0, 40)) console.log(`  ${r.cadena.padEnd(18)} ${r.ean}  ${r.desc.slice(0, 45)}`);

  console.log(`\n=== Q2: client EANs COMPLETELY ABSENT from the export ===`);
  const missingClient = [...clientEans].filter((e) => !exportEans.has(e));
  console.log(`Client EANs with zero rows in export: ${missingClient.length}`);
  console.log('  ' + missingClient.slice(0, 30).join(', '));

  // ---- Q3: the two specific cases ----
  const cases: { chain: string; supId: string; ean: string }[] = [
    { chain: 'Changomás', supId: 'changomas', ean: '7791130683524' },
    { chain: 'Átomo', supId: 'atomo', ean: '7790117000071' },
  ];
  for (const c of cases) {
    console.log(`\n${'='.repeat(70)}\n=== CASE: ${c.chain} / EAN ${c.ean} ===`);
    const url = cellUrl.get(`${c.supId}::${c.ean}`);
    console.log(`  Excel URL: ${url ?? '(no URL in sheet)'}`);
    console.log(`  In export? ${exportEans.has(c.ean) ? 'EAN present (maybe other chains)' : 'EAN NOT in export at all'}`);

    // Any mapping at this chain matching the URL?
    if (url) {
      const { data: all } = await db.from('supermarket_products').select('id, product_id, is_active, external_id, external_url, products(ean, name)').eq('supermarket_id', c.supId);
      const rows = (all ?? []) as unknown as { is_active: boolean; external_id: string; external_url: string | null; products: { ean: string | null; name: string } | null }[];
      const hit = rows.find((r) => r.external_url && normUrl(r.external_url) === normUrl(url));
      if (hit) console.log(`  → We DO have this URL mapped at ${c.supId}: ean=${hit.products?.ean} active=${hit.is_active} extId=${hit.external_id} name="${hit.products?.name}"`);
      else console.log(`  → No mapping at ${c.supId} matches this URL. (never successfully ingested here)`);
    }
    // Any mapping at this chain for the client-EAN product?
    const { data: prod } = await db.from('products').select('id, name').eq('ean', c.ean).maybeSingle();
    if (prod) {
      const { data: m } = await db.from('supermarket_products').select('is_active, external_id').eq('product_id', (prod as { id: string }).id).eq('supermarket_id', c.supId);
      console.log(`  Client-EAN product "${(prod as { name: string }).name}" mapping at ${c.supId}: ${m && m.length ? JSON.stringify(m) : 'NONE'}`);
    } else console.log(`  No product row with client EAN ${c.ean}.`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
