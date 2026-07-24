/**
 * Export the authoritative catalog (original 211 ∪ catalog_extra_eans) to an
 * .xlsx for reconciliation against the client's master list.
 *
 * Columns: EAN, ORIGEN (original-211 | extra), CATEGORIA, SUBCATEGORIA, MARCA,
 * FABRICANTE, FORMATO, VARIEDAD, DESCRIPCION, REPORTADO (flag for the EANs the
 * client asked us to remove).
 *
 * Read-only. Run: npx tsx --env-file=.env scripts/export-catalog.ts [out.xlsx]
 */
import ExcelJSmod from 'exceljs';
import { db } from '../src/shared/db.js';
import { TAXONOMY_BY_EAN, type TaxonomyEntry } from '../src/shared/taxonomy.js';

const ExcelJS = (ExcelJSmod as unknown as { default?: typeof import('exceljs') }).default ?? ExcelJSmod;

// EANs the client reported as "shouldn't be here" (highlighted in the export).
const REPORTED = new Set([
  '7791905002499', '7791905002505', '7791905023197',
  '7792389000315', '7792389001503', '7798270241218',
]);

interface ExtraRow {
  ean: string; description_forms: string | null; category: string | null; subcategory: string | null;
  brand: string | null; manufacturer: string | null; format: string | null; variety: string | null;
}

async function main(): Promise<void> {
  const outPath = process.argv[2] ?? `C:\\Users\\fran-\\Downloads\\catalogo-reconciliacion_${new Date().toISOString().slice(0, 10)}.xlsx`;

  const { data: extras, error } = await db
    .from('catalog_extra_eans')
    .select('ean, description_forms, category, subcategory, brand, manufacturer, format, variety');
  if (error) throw error;

  // Any extra EAN that also exists in the hardcoded 211 is a true duplicate
  // (shadowed by the built-in) — surface it so we can spot double-counting.
  const extraList = (extras ?? []) as ExtraRow[];
  const shadowed = extraList.filter((e) => TAXONOMY_BY_EAN.has(e.ean));

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Catalogo');
  ws.addRow(['EAN', 'ORIGEN', 'CATEGORIA', 'SUBCATEGORIA', 'MARCA', 'FABRICANTE', 'FORMATO', 'VARIEDAD', 'DESCRIPCION', 'REPORTADO']).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  const addRow = (ean: string, origen: string, t: Pick<TaxonomyEntry, 'category' | 'subcategory' | 'brand' | 'manufacturer' | 'format' | 'variety' | 'descriptionForms'>): void => {
    const r = ws.addRow([ean, origen, t.category, t.subcategory, t.brand, t.manufacturer, t.format, t.variety, t.descriptionForms, REPORTED.has(ean) ? 'SI' : '']);
    if (REPORTED.has(ean)) for (let c = 1; c <= 10; c++) r.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC7CE' } };
  };

  // original 211 (sorted by brand → description)
  const builtins = [...TAXONOMY_BY_EAN.values()].sort((a, b) => (a.brand || '').localeCompare(b.brand || '') || (a.descriptionForms || '').localeCompare(b.descriptionForms || ''));
  for (const t of builtins) addRow(t.ean, 'original-211', t);

  // extras (skip ones shadowed by a built-in so the count matches the live catalog)
  const extrasEffective = extraList.filter((e) => !TAXONOMY_BY_EAN.has(e.ean))
    .sort((a, b) => (a.brand || '').localeCompare(b.brand || '') || (a.description_forms || '').localeCompare(b.description_forms || ''));
  for (const e of extrasEffective) addRow(e.ean, 'extra', {
    category: e.category ?? '', subcategory: e.subcategory ?? '', brand: e.brand ?? '', manufacturer: e.manufacturer ?? '',
    format: e.format ?? '', variety: e.variety ?? '', descriptionForms: e.description_forms ?? '',
  });

  ws.columns = [{ width: 16 }, { width: 13 }, { width: 16 }, { width: 14 }, { width: 16 }, { width: 24 }, { width: 10 }, { width: 10 }, { width: 40 }, { width: 11 }];

  await wb.xlsx.writeFile(outPath);

  console.log(`Catalog export → ${outPath}`);
  console.log(`  original 211 (taxonomy.ts): ${TAXONOMY_BY_EAN.size}`);
  console.log(`  catalog_extra_eans rows:    ${extraList.length}`);
  console.log(`    of those, DUPLICATE of a built-in (double-counted!): ${shadowed.length}${shadowed.length ? '  → ' + shadowed.map((s) => s.ean).join(', ') : ''}`);
  console.log(`  extras that are genuinely new: ${extrasEffective.length}`);
  console.log(`  => EFFECTIVE catalog total: ${TAXONOMY_BY_EAN.size + extrasEffective.length}`);
  console.log(`  reported "remove" EANs present: ${[...REPORTED].filter((e) => TAXONOMY_BY_EAN.has(e)).length}/${REPORTED.size}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
