// TEMP: investigate the "EANs Depurados SIN PRODUCTOS" reported-missing list. Delete after.
import ExcelJSmod from 'exceljs';
import { db } from '../src/shared/db.js';
import { getCatalogEans } from '../src/shared/catalog.js';
import { writeFileSync } from 'node:fs';

const ExcelJS = (ExcelJSmod as unknown as { default?: typeof import('exceljs') }).default ?? ExcelJSmod;
const XLSX = 'C:\\Users\\fran-\\Downloads\\Validación_150726.xlsx';
const OUT = 'C:\\Users\\fran-\\Downloads\\Validacion_investigacion.csv';

// Column header (as written in the sheet) → supermarket id in our DB.
const SUP_ALIAS: Record<string, string> = {
  'ATOMO': 'atomo', 'CALIFORNIA': 'california', 'CARREFOUR': 'carrefour', 'CHANGOMAS': 'changomas',
  'COMODIN': 'comodin', 'CORDIEZ': 'cordiez', 'COTO': 'coto', 'DÍA': 'dia', 'DIA': 'dia', 'DISCO': 'disco',
  'EL ABASTECEDOR': 'el-abastecedor', 'JOSIMAR': 'josimar', 'JUMBO': 'jumbo', 'LA ANONIMA': 'la-anonima',
  'LA COPPE EN CASA': 'lacoopeencasa', 'LA COOPE EN CASA': 'lacoopeencasa', 'LA GALLEGA': 'la-gallega',
  'LA GENOVESA': 'la-genovesa', 'LA REINA': 'la-reina', 'MAMI': 'mami', 'MAXICARREFOUR': 'maxi-carrefour',
  'MAXICONSUMO': 'maxiconsumo', 'PARODI': 'parodi', 'SUPERTOP': 'supertop', 'VEA': 'vea', 'ROSENTAL': 'rosental',
};

const cell = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return String(o.result ?? o.text ?? '').trim();
  }
  return String(v).trim();
};

async function fetchAll<T>(table: string, columns: string, orderBy: string): Promise<T[]> {
  const pageSize = 1000; const all: T[] = []; let off = 0;
  for (;;) {
    const { data, error } = await db.from(table).select(columns).order(orderBy, { ascending: true }).range(off, off + pageSize - 1);
    if (error) throw error;
    const rows = (data ?? []) as unknown as T[];
    all.push(...rows);
    if (rows.length < pageSize) break; off += pageSize;
  }
  return all;
}

async function main(): Promise<void> {
  // ---- Parse the sheet into (supId, ean) pairs ----------------------------
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(XLSX);
  const ws = wb.getWorksheet('EANs Depurados SIN PRODUCTOS')!;

  const colToSup = new Map<number, { header: string; id: string | null }>();
  ws.getRow(1).eachCell({ includeEmpty: false }, (c, col) => {
    const header = cell(c.value);
    if (header) colToSup.set(col, { header, id: SUP_ALIAS[header.toUpperCase()] ?? null });
  });

  const pairs: { supId: string; header: string; ean: string }[] = [];
  const unmatchedHeaders = new Set<string>();
  for (let r = 2; r <= ws.rowCount; r++) {
    ws.getRow(r).eachCell({ includeEmpty: false }, (c, col) => {
      const sup = colToSup.get(col);
      if (!sup) return;
      const v = cell(c.value);
      if (!/^\d{8,14}$/.test(v)) return; // skip count row + junk
      if (!sup.id) { unmatchedHeaders.add(sup.header); return; }
      pairs.push({ supId: sup.id, header: sup.header, ean: v });
    });
  }
  console.log(`Parsed ${pairs.length} (supermarket, EAN) pairs across ${colToSup.size} columns.`);
  if (unmatchedHeaders.size) console.log(`⚠ Unmatched column headers (skipped): ${[...unmatchedHeaders].join(', ')}`);

  // ---- Load DB state ------------------------------------------------------
  const catalog = await getCatalogEans();
  const sups = await fetchAll<{ id: string; is_active: boolean }>('supermarkets', 'id, is_active', 'id');
  const supActive = new Map(sups.map((s) => [s.id, s.is_active]));
  const knownSup = new Set(sups.map((s) => s.id));
  const products = await fetchAll<{ id: string; ean: string | null }>('products', 'id, ean', 'id');
  const maps = await fetchAll<{ id: string; supermarket_id: string; product_id: string; is_active: boolean; external_url: string | null }>(
    'supermarket_products', 'id, supermarket_id, product_id, is_active, external_url', 'product_id');

  const eanToPids = new Map<string, string[]>();
  for (const p of products) { if (p.ean) { const a = eanToPids.get(p.ean) ?? []; a.push(p.id); eanToPids.set(p.ean, a); } }
  // key = `${supId}::${productId}` → mapping rows
  const mapsBySupProd = new Map<string, { is_active: boolean; url: string | null }[]>();
  for (const m of maps) {
    const k = `${m.supermarket_id}::${m.product_id}`;
    const a = mapsBySupProd.get(k) ?? []; a.push({ is_active: m.is_active, url: m.external_url }); mapsBySupProd.set(k, a);
  }

  // Validate alias ids exist.
  for (const [, sup] of colToSup) {
    if (sup.id && !knownSup.has(sup.id)) console.log(`⚠ alias "${sup.header}" → "${sup.id}" NOT a known supermarket id`);
  }

  // ---- Categorize each pair ----------------------------------------------
  type Bucket =
    | 'active_here'        // mapped + active at this chain → should be in export
    | 'paused_here'        // mapping exists but is_active=false → reactivate
    | 'no_mapping_here'    // product exists elsewhere but never added at this chain
    | 'no_product'         // no product row anywhere with this EAN → never ingested at all
    | 'chain_inactive'     // the whole chain is deactivated
    | 'bad_ean';           // not 13 digits
  interface Row { supId: string; header: string; ean: string; catalog: string; bucket: Bucket; detail: string }
  const out: Row[] = [];

  for (const { supId, header, ean } of pairs) {
    const inCat = catalog.has(ean) ? 'in-catalog' : 'off-catalog';
    if (!/^\d{13}$/.test(ean)) { out.push({ supId, header, ean, catalog: inCat, bucket: 'bad_ean', detail: `${ean.length} digits` }); continue; }
    if (supActive.get(supId) === false) { out.push({ supId, header, ean, catalog: inCat, bucket: 'chain_inactive', detail: '' }); continue; }

    const pids = eanToPids.get(ean) ?? [];
    if (pids.length === 0) { out.push({ supId, header, ean, catalog: inCat, bucket: 'no_product', detail: '' }); continue; }

    let active: string | null = null, paused: string | null = null;
    for (const pid of pids) {
      for (const m of mapsBySupProd.get(`${supId}::${pid}`) ?? []) {
        if (m.is_active) active = m.url ?? ''; else paused = m.url ?? '';
      }
    }
    if (active !== null) out.push({ supId, header, ean, catalog: inCat, bucket: 'active_here', detail: active });
    else if (paused !== null) out.push({ supId, header, ean, catalog: inCat, bucket: 'paused_here', detail: paused });
    else out.push({ supId, header, ean, catalog: inCat, bucket: 'no_mapping_here', detail: `product exists at other chains` });
  }

  // ---- Summary ------------------------------------------------------------
  const byBucket = new Map<string, number>();
  for (const r of out) byBucket.set(r.bucket, (byBucket.get(r.bucket) ?? 0) + 1);
  console.log('\n=== OVERALL ===');
  for (const [k, n] of [...byBucket.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(18)} ${n}`);

  console.log('\n=== By supermarket (bucket breakdown) ===');
  const bySup = new Map<string, Map<string, number>>();
  for (const r of out) {
    if (!bySup.has(r.header)) bySup.set(r.header, new Map());
    const m = bySup.get(r.header)!; m.set(r.bucket, (m.get(r.bucket) ?? 0) + 1);
  }
  for (const [header, m] of [...bySup.entries()].sort()) {
    const parts = [...m.entries()].sort((a, b) => b[1] - a[1]).map(([b, n]) => `${b}:${n}`).join('  ');
    console.log(`  ${header.padEnd(18)} ${parts}`);
  }

  // ---- CSV ----------------------------------------------------------------
  const esc = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = ['Supermercado,EAN,Catalogo,Estado,Detalle'];
  for (const r of out) lines.push([r.header, r.ean, r.catalog, r.bucket, r.detail].map(esc).join(','));
  writeFileSync(OUT, '\uFEFF' + lines.join('\r\n') + '\r\n', 'utf8');
  console.log(`\nWrote ${out.length} rows → ${OUT}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
