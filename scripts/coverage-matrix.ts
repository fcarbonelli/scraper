/**
 * Coverage matrix report: one row per catalog EAN, one column per supermarket.
 *
 * Each cell shows whether we have that EAN mapped at that chain and in which
 * state, encoded by background color:
 *   - green  "X"   → active (scraped normally)
 *   - yellow "OOS" → active but lifecycle = out_of_stock
 *   - orange "DEL" → active but lifecycle = delisted
 *   - grey   "P"   → paused (is_active = false; invisible to the client export)
 *   - blank        → no mapping at that chain
 *
 * The client universe is the AUTHORITATIVE catalog (hardcoded 211 ∪
 * catalog_extra_eans), NOT any URL sheet. Read-only: writes an .xlsx, no DB
 * mutations.
 *
 * Run: npx tsx --env-file=.env scripts/coverage-matrix.ts [out.xlsx]
 */
import ExcelJSmod from 'exceljs';
import { db } from '../src/shared/db.js';
import { getCatalogEans } from '../src/shared/catalog.js';

const ExcelJS = (ExcelJSmod as unknown as { default?: typeof import('exceljs') }).default ?? ExcelJSmod;

/** Cell state, in priority order (best/most-visible first). */
type State = 'active' | 'out_of_stock' | 'delisted' | 'paused';
const PRIORITY: State[] = ['active', 'out_of_stock', 'delisted', 'paused'];

const STYLE: Record<State, { label: string; argb: string }> = {
  active: { label: 'X', argb: 'FFC6EFCE' }, // green
  out_of_stock: { label: 'OOS', argb: 'FFFFEB9C' }, // yellow
  delisted: { label: 'DEL', argb: 'FFF8CBAD' }, // orange
  paused: { label: 'P', argb: 'FFD9D9D9' }, // grey
};

async function fetchAll<T>(table: string, cols: string, orderBy: string): Promise<T[]> {
  const all: T[] = [];
  let off = 0;
  for (;;) {
    const { data, error } = await db.from(table).select(cols).order(orderBy).range(off, off + 999);
    if (error) throw error;
    const rows = (data ?? []) as unknown as T[];
    all.push(...rows);
    if (rows.length < 1000) break;
    off += 1000;
  }
  return all;
}

async function main(): Promise<void> {
  const outPath =
    process.argv[2] ??
    `C:\\Users\\fran-\\Downloads\\coverage-matrix_${new Date().toISOString().slice(0, 10)}.xlsx`;

  const catalog = await getCatalogEans();

  const sups = await fetchAll<{ id: string; name: string; is_active: boolean }>(
    'supermarkets',
    'id, name, is_active',
    'name',
  );
  // Active chains first, then deactivated ones (kept for visibility).
  sups.sort((a, b) => Number(b.is_active) - Number(a.is_active) || a.name.localeCompare(b.name));

  const products = await fetchAll<{ id: string; ean: string | null }>('products', 'id, ean', 'id');
  const productIdsByEan = new Map<string, string[]>();
  for (const p of products) {
    if (p.ean && catalog.has(p.ean)) {
      (productIdsByEan.get(p.ean) ?? productIdsByEan.set(p.ean, []).get(p.ean)!).push(p.id);
    }
  }

  const maps = await fetchAll<{
    product_id: string;
    supermarket_id: string;
    is_active: boolean;
    lifecycle_status: string;
  }>('supermarket_products', 'product_id, supermarket_id, is_active, lifecycle_status', 'product_id');
  const mapsByProduct = new Map<string, typeof maps>();
  for (const m of maps) {
    (mapsByProduct.get(m.product_id) ?? mapsByProduct.set(m.product_id, []).get(m.product_id)!).push(m);
  }

  const stateOf = (m: (typeof maps)[number]): State => {
    if (!m.is_active) return 'paused';
    if (m.lifecycle_status === 'out_of_stock') return 'out_of_stock';
    if (m.lifecycle_status === 'delisted') return 'delisted';
    return 'active';
  };
  const bestState = (states: State[]): State | null => {
    for (const s of PRIORITY) if (states.includes(s)) return s;
    return null;
  };

  // ---- Build workbook ----
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Cobertura', { views: [{ state: 'frozen', xSplit: 3, ySplit: 1 }] });

  const header = ['EAN', 'DESCRIPCION', 'MARCA', ...sups.map((s) => s.name), '# ACTIVOS'];
  const headerRow = ws.addRow(header);
  headerRow.font = { bold: true };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  headerRow.height = 42;
  // Deactivated chains: red header text so it's obvious the whole column is off.
  sups.forEach((s, i) => {
    if (!s.is_active) headerRow.getCell(4 + i).font = { bold: true, color: { argb: 'FFC00000' } };
  });

  // Sort EAN rows by brand then description for readability.
  const eanRows = [...catalog.entries()]
    .map(([ean, tax]) => ({ ean, tax }))
    .sort(
      (a, b) =>
        (a.tax.brand || '').localeCompare(b.tax.brand || '') ||
        (a.tax.descriptionForms || '').localeCompare(b.tax.descriptionForms || ''),
    );

  const totals = { active: 0, out_of_stock: 0, delisted: 0, paused: 0, none: 0 } as Record<State | 'none', number>;

  for (const { ean, tax } of eanRows) {
    const desc = [tax.descriptionForms, tax.variety, tax.format].filter(Boolean).join(' ');
    const row = ws.addRow([ean, desc, tax.brand || '', ...sups.map(() => ''), 0]);
    let activeCount = 0;

    sups.forEach((s, i) => {
      const cell = row.getCell(4 + i);
      const productIds = productIdsByEan.get(ean) ?? [];
      const states: State[] = [];
      for (const pid of productIds) {
        for (const m of mapsByProduct.get(pid) ?? []) {
          if (m.supermarket_id === s.id) states.push(stateOf(m));
        }
      }
      const best = bestState(states);
      if (!best) {
        totals.none++;
        return;
      }
      totals[best]++;
      if (best === 'active') activeCount++;
      const style = STYLE[best];
      cell.value = style.label;
      cell.alignment = { horizontal: 'center' };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: style.argb } };
    });

    row.getCell(4 + sups.length).value = activeCount;
    row.getCell(1).font = { name: 'Consolas' };
  }

  // Column widths.
  ws.getColumn(1).width = 15;
  ws.getColumn(2).width = 34;
  ws.getColumn(3).width = 16;
  sups.forEach((_, i) => (ws.getColumn(4 + i).width = 6));
  ws.getColumn(4 + sups.length).width = 10;
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 3 } };

  // ---- Legend sheet ----
  const legend = wb.addWorksheet('Leyenda');
  legend.getColumn(1).width = 10;
  legend.getColumn(2).width = 60;
  legend.addRow(['Celda', 'Significado']).font = { bold: true };
  const legendRows: [State, string][] = [
    ['active', 'Activo — se scrapea normalmente y aparece en el export del cliente'],
    ['out_of_stock', 'Activo pero marcado SIN STOCK (out_of_stock) — emite marcador, sin precio'],
    ['delisted', 'Activo pero DADO DE BAJA (delisted) — producto oficialmente discontinuado'],
    ['paused', 'PAUSADO (is_active=false) — NO aparece en el export del cliente'],
  ];
  for (const [st, meaning] of legendRows) {
    const r = legend.addRow([STYLE[st].label, meaning]);
    r.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: STYLE[st].argb } };
    r.getCell(1).alignment = { horizontal: 'center' };
  }
  legend.addRow([]);
  legend.addRow(['(vacío)', 'No tenemos ese EAN mapeado en esa cadena']);
  legend.addRow([]);
  legend.addRow(['Encabezado en rojo', 'Cadena DESACTIVADA (supermarkets.is_active=false): ninguna celda de esa columna aparece en el export']);

  await wb.xlsx.writeFile(outPath);

  const activeChains = sups.filter((s) => s.is_active).length;
  console.log(`Matrix written → ${outPath}`);
  console.log(`  EANs (rows): ${eanRows.length}   Supermarkets (cols): ${sups.length} (${activeChains} active, ${sups.length - activeChains} deactivated)`);
  console.log(`  Cells — active: ${totals.active}  out_of_stock: ${totals.out_of_stock}  delisted: ${totals.delisted}  paused: ${totals.paused}  empty: ${totals.none}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
