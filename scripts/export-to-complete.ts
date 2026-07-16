/**
 * Build a "productos a completar" workbook for the client: every product that
 * appears in our scrape but can't be formatted to the client's contract because
 * its taxonomy is unknown. Two groups:
 *
 *   1. extra_incompleto  — already in catalog_extra_eans (the second list) but
 *                          missing a required column (usually Fabricante). We
 *                          prefill the columns we DO have; the blank ones need
 *                          the client.
 *   2. fuera_de_catalogo — has an EAN that is in NEITHER the 211 reference NOR
 *                          the extras list. Everything needs classifying (or the
 *                          EAN corrected / the product dropped).
 *
 * Read-only. Writes an .xlsx the operator can forward to the client.
 *
 *   npx tsx --env-file=.env scripts/export-to-complete.ts
 *   npx tsx --env-file=.env scripts/export-to-complete.ts --out "C:\path\file.xlsx"
 */

import ExcelJSmod from 'exceljs';
import { db } from '../src/shared/db.js';
import { getCatalogEans } from '../src/shared/catalog.js';

const ExcelJS = (ExcelJSmod as unknown as { default?: typeof import('exceljs') }).default ?? ExcelJSmod;

const REQUIRED = ['category', 'subcategory', 'brand', 'manufacturer'] as const;

interface ProductRow {
  id: string;
  ean: string | null;
  name: string | null;
  brand: string | null;
}
interface SmpRow { supermarket_id: string; product_id: string; is_active: boolean }
interface SupRow { id: string; is_active: boolean; cadena_display_name: string | null; name: string }
interface ExtraRow {
  ean: string; description_forms: string | null; category: string | null;
  subcategory: string | null; brand: string | null; manufacturer: string | null;
  format: string | null; variety: string | null;
}

async function fetchAll<T>(table: string, columns: string, orderBy: string): Promise<T[]> {
  const pageSize = 1000;
  const all: T[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await db
      .from(table)
      .select(columns)
      .order(orderBy, { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    const rows = (data ?? []) as unknown as T[];
    all.push(...rows);
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const today = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
  const outPath = outIdx >= 0 && args[outIdx + 1]
    ? args[outIdx + 1]!
    : `C:\\Users\\fran-\\Downloads\\productos_a_completar_${today}.xlsx`;

  const [catalog, products, mappings, supermarkets, extras] = await Promise.all([
    getCatalogEans(),
    fetchAll<ProductRow>('products', 'id, ean, name, brand', 'id'),
    fetchAll<SmpRow>('supermarket_products', 'supermarket_id, product_id, is_active', 'product_id'),
    fetchAll<SupRow>('supermarkets', 'id, is_active, cadena_display_name, name', 'id'),
    fetchAll<ExtraRow>('catalog_extra_eans', 'ean, description_forms, category, subcategory, brand, manufacturer, format, variety', 'ean'),
  ]);

  const productById = new Map(products.map((p) => [p.id, p]));
  const supById = new Map(supermarkets.map((s) => [s.id, s]));

  // chains where a given EAN has an ACTIVE mapping under an ACTIVE supermarket
  // (mirrors what the client_base export will actually show after migration 008).
  const chainsByEan = new Map<string, Set<string>>();
  for (const m of mappings) {
    if (!m.is_active) continue;
    const sup = supById.get(m.supermarket_id);
    if (!sup || !sup.is_active) continue;
    const prod = productById.get(m.product_id);
    if (!prod?.ean) continue;
    const label = sup.cadena_display_name ?? sup.name.toUpperCase();
    if (!chainsByEan.has(prod.ean)) chainsByEan.set(prod.ean, new Set());
    chainsByEan.get(prod.ean)!.add(label);
  }

  // representative product name per EAN
  const nameByEan = new Map<string, string>();
  const brandByEan = new Map<string, string>();
  for (const p of products) {
    if (!p.ean) continue;
    if (p.name && !nameByEan.has(p.ean)) nameByEan.set(p.ean, p.name);
    if (p.brand && !brandByEan.has(p.ean)) brandByEan.set(p.ean, p.brand);
  }

  interface OutRow {
    fuente: string; ean: string; descripcion_sitio: string; cadenas: string; n_cadenas: number;
    categoria: string; subcategoria: string; fabricante: string; marca: string;
    formato: string; variedad: string; descripcion_para_forms: string;
  }
  const out: OutRow[] = [];

  // Group 1: incomplete extras (in the second list, missing a required field).
  for (const r of extras) {
    const missing = REQUIRED.filter((f) => !r[f]);
    if (missing.length === 0) continue;
    const chains = chainsByEan.get(r.ean);
    out.push({
      fuente: 'extra_incompleto',
      ean: r.ean,
      descripcion_sitio: nameByEan.get(r.ean) ?? r.description_forms ?? '',
      cadenas: chains ? [...chains].sort().join(', ') : '(sin mapeo activo)',
      n_cadenas: chains?.size ?? 0,
      categoria: r.category ?? '',
      subcategoria: r.subcategory ?? '',
      fabricante: r.manufacturer ?? '',
      marca: r.brand ?? '',
      formato: r.format ?? '',
      variedad: r.variety ?? '',
      descripcion_para_forms: r.description_forms ?? '',
    });
  }

  // Group 2: off-catalog EANs (active mappings only), not in built-in nor extras.
  const seenOff = new Set<string>();
  for (const [ean, chains] of chainsByEan) {
    if (catalog.has(ean)) continue;
    if (seenOff.has(ean)) continue;
    seenOff.add(ean);
    out.push({
      fuente: 'fuera_de_catalogo',
      ean,
      descripcion_sitio: nameByEan.get(ean) ?? '',
      cadenas: [...chains].sort().join(', '),
      n_cadenas: chains.size,
      categoria: '', subcategoria: '', fabricante: '',
      marca: brandByEan.get(ean) ?? '',
      formato: '', variedad: '', descripcion_para_forms: '',
    });
  }

  out.sort((a, b) => a.fuente.localeCompare(b.fuente) || b.n_cadenas - a.n_cadenas);

  // --- Write workbook -------------------------------------------------------
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('A completar');
  ws.columns = [
    { header: 'Fuente', key: 'fuente', width: 18 },
    { header: 'EAN', key: 'ean', width: 16 },
    { header: 'Descripcion_Sitio', key: 'descripcion_sitio', width: 48 },
    { header: 'Cadenas', key: 'cadenas', width: 40 },
    { header: 'N_Cadenas', key: 'n_cadenas', width: 10 },
    { header: 'CATEGORIA', key: 'categoria', width: 16 },
    { header: 'SUBCATEGORIA', key: 'subcategoria', width: 16 },
    { header: 'FABRICANTE', key: 'fabricante', width: 24 },
    { header: 'MARCA', key: 'marca', width: 18 },
    { header: 'FORMATO', key: 'formato', width: 12 },
    { header: 'VARIEDAD', key: 'variedad', width: 12 },
    { header: 'DESCRIPCION_PARA_FORMS', key: 'descripcion_para_forms', width: 40 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  for (const r of out) ws.addRow(r);

  await wb.xlsx.writeFile(outPath);

  const g1 = out.filter((r) => r.fuente === 'extra_incompleto').length;
  const g2 = out.filter((r) => r.fuente === 'fuera_de_catalogo').length;
  console.log(`\nWrote ${out.length} rows  (extra_incompleto ${g1}, fuera_de_catalogo ${g2})`);
  console.log(`→ ${outPath}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
