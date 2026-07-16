/**
 * Import a filled "productos a completar" workbook (see export-to-complete.ts).
 *
 * The file drives every action — no hardcoded EANs:
 *   - A row with CATEGORIA filled  → KEEP: upsert into catalog_extra_eans with
 *     the client's taxonomy (completes an incomplete extra, or adds a brand-new
 *     official EAN). The master rows are re-stamped afterwards by seed-taxonomy.
 *   - A `fuera_de_catalogo` row with CATEGORIA blank → REMOVE: pause every
 *     supermarket_products mapping for that EAN (is_active=false → drops out of
 *     client_base, stops being scraped; reversible, history retained).
 *
 * Only the "A completar" sheet is read; any helper sheets are ignored.
 * Idempotent. Dry-run by default.
 *
 *   npx tsx --env-file=.env scripts/import-completed.ts "C:\path\file.xlsx"
 *   npx tsx --env-file=.env scripts/import-completed.ts "C:\path\file.xlsx" --apply
 */

import ExcelJSmod from 'exceljs';
import type { Row as ExcelRow } from 'exceljs';
import { db } from '../src/shared/db.js';

const ExcelJS = (ExcelJSmod as unknown as { default?: typeof import('exceljs') }).default ?? ExcelJSmod;

interface Parsed {
  fuente: string;
  ean: string;
  descripcionSitio: string;
  categoria: string;
  subcategoria: string;
  fabricante: string;
  marca: string;
  formato: string;
  variedad: string;
  descripcionForms: string;
}

/** Pull a cell value as a clean string (handles ExcelJS rich text / numbers). */
function cellStr(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.richText)) return (o.richText as { text: string }[]).map((t) => t.text).join('').trim();
    if (typeof o.text === 'string') return o.text.trim();
    if (o.result !== undefined) return String(o.result).trim();
    return '';
  }
  return String(v).trim();
}

async function readRows(path: string): Promise<Parsed[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const ws = wb.getWorksheet('A completar') ?? wb.worksheets[0];
  if (!ws) throw new Error('No worksheet found');

  // Map header name → column index from row 1.
  const header = new Map<string, number>();
  ws.getRow(1).eachCell((cell, col) => header.set(cellStr(cell.value).toUpperCase(), col));
  const col = (name: string): number => header.get(name.toUpperCase()) ?? -1;
  const get = (row: ExcelRow, name: string): string => {
    const c = col(name);
    return c > 0 ? cellStr(row.getCell(c).value) : '';
  };

  const rows: Parsed[] = [];
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    if (n === 1) return;
    const ean = get(row, 'EAN');
    if (!ean) return;
    rows.push({
      fuente: get(row, 'Fuente'),
      ean,
      descripcionSitio: get(row, 'Descripcion_Sitio'),
      categoria: get(row, 'CATEGORIA'),
      subcategoria: get(row, 'SUBCATEGORIA'),
      fabricante: get(row, 'FABRICANTE'),
      marca: get(row, 'MARCA'),
      formato: get(row, 'FORMATO'),
      variedad: get(row, 'VARIEDAD'),
      descripcionForms: get(row, 'DESCRIPCION_PARA_FORMS'),
    });
  });
  return rows;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const path = args.find((a) => !a.startsWith('--'));
  if (!path) throw new Error('Pass the workbook path as the first argument.');

  const rows = await readRows(path);

  const keep = rows.filter((r) => r.categoria.length > 0);
  const remove = rows.filter((r) => r.categoria.length === 0);

  console.log(`\nParsed ${rows.length} rows → KEEP/upsert ${keep.length}, REMOVE/deactivate ${remove.length}\n`);

  console.log('KEEP (upsert into catalog_extra_eans):');
  for (const r of keep) {
    console.log(`  ${r.ean}  ${r.categoria}/${r.subcategoria}  ${r.marca} — ${r.fabricante}  [${r.formato}]`);
  }
  console.log('\nREMOVE (deactivate all mappings):');
  for (const r of remove) console.log(`  ${r.ean}  ${r.descripcionSitio}`);

  if (!apply) {
    console.log('\nDry-run — re-run with --apply to write.');
    process.exit(0);
  }

  // --- KEEP: upsert catalog_extra_eans -------------------------------------
  let upserted = 0;
  for (const r of keep) {
    const description_forms = r.descripcionForms || r.descripcionSitio || r.ean;
    const { error } = await db.from('catalog_extra_eans').upsert(
      {
        ean: r.ean,
        description_forms,
        category: r.categoria || null,
        subcategory: r.subcategoria || null,
        brand: r.marca || null,
        manufacturer: r.fabricante || null,
        format: r.formato || null,
        variety: r.variedad || null,
        created_by: 'import-completed',
      },
      { onConflict: 'ean' },
    );
    if (error) {
      console.error(`  upsert failed ${r.ean}:`, error.message);
      continue;
    }
    upserted++;
  }
  console.log(`\nUpserted ${upserted}/${keep.length} catalog_extra_eans rows.`);

  // --- REMOVE: deactivate every mapping for those EANs ----------------------
  let deactivatedMappings = 0;
  let productsTouched = 0;
  for (const r of remove) {
    const { data: prods, error: pErr } = await db.from('products').select('id').eq('ean', r.ean);
    if (pErr) { console.error(`  products lookup failed ${r.ean}:`, pErr.message); continue; }
    const ids = (prods ?? []).map((p) => p.id as string);
    if (ids.length === 0) continue;
    productsTouched += ids.length;

    const { data: upd, error: uErr } = await db
      .from('supermarket_products')
      .update({ is_active: false })
      .in('product_id', ids)
      .eq('is_active', true)
      .select('id');
    if (uErr) { console.error(`  deactivate failed ${r.ean}:`, uErr.message); continue; }
    deactivatedMappings += (upd ?? []).length;
  }
  console.log(`Deactivated ${deactivatedMappings} mappings across ${productsTouched} master products.`);

  console.log('\nNext: propagate taxonomy to master rows →');
  console.log('  npx tsx --env-file=.env scripts/seed-taxonomy.ts --apply');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
