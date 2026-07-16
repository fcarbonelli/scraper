/**
 * Import a filled "no_ean_a_revisar" workbook (see prune-noean.ts).
 *
 * Per row (keyed by MAPPING_ID = a supermarket_products.id):
 *   - EAN_CONFIRMAR holds a valid EAN → BIND: re-point the mapping to the
 *     canonical catalog master for that EAN and enrich its columns
 *     (bindMappingToEan). Price history is preserved (snapshots key on the
 *     mapping). This is the "heal" path — the blank EAN/Categoria/Marca cells
 *     stop appearing in the export.
 *   - ACCION contains "elimin…" (and no confirmed EAN) → REMOVE: deactivate the
 *     mapping (is_active=false). Drops out of client_base, reversible.
 *   - both blank → SKIP (leave untouched).
 *
 * Idempotent. Dry-run by default.
 *
 *   npx tsx --env-file=.env scripts/import-noean.ts "C:\path\file.xlsx"
 *   npx tsx --env-file=.env scripts/import-noean.ts "C:\path\file.xlsx" --apply
 */

import ExcelJSmod from 'exceljs';
import { db } from '../src/shared/db.js';
import { bindMappingToEan } from '../src/ingest/bindEan.js';

const ExcelJS = (ExcelJSmod as unknown as { default?: typeof import('exceljs') }).default ?? ExcelJSmod;

interface Row {
  mappingId: string;
  name: string;
  confirmEan: string;
  accion: string;
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

async function readRows(path: string): Promise<Row[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const ws = wb.getWorksheet('No EAN a revisar') ?? wb.worksheets[0];
  if (!ws) throw new Error('No worksheet found');

  const header = new Map<string, number>();
  ws.getRow(1).eachCell((cell, col) => header.set(cellStr(cell.value).toUpperCase(), col));
  const col = (name: string): number => header.get(name.toUpperCase()) ?? -1;
  const get = (row: ExcelJS.Row, name: string): string => {
    const c = col(name);
    return c > 0 ? cellStr(row.getCell(c).value) : '';
  };

  const rows: Row[] = [];
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    if (n === 1) return;
    const mappingId = get(row, 'MAPPING_ID');
    if (!mappingId) return;
    rows.push({
      mappingId,
      name: get(row, 'Descripcion_Sitio'),
      confirmEan: get(row, 'EAN_CONFIRMAR').replace(/\D/g, ''),
      accion: get(row, 'ACCION').toLowerCase(),
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

  const bind = rows.filter((r) => /^\d{8,14}$/.test(r.confirmEan));
  const remove = rows.filter((r) => !/^\d{8,14}$/.test(r.confirmEan) && r.accion.includes('elimin'));
  const skip = rows.filter((r) => !bind.includes(r) && !remove.includes(r));

  console.log(`\nParsed ${rows.length} rows → BIND ${bind.length}, REMOVE ${remove.length}, SKIP ${skip.length}\n`);
  console.log('BIND (heal → catalog EAN):');
  for (const r of bind) console.log(`  ${r.mappingId} → ${r.confirmEan}  (${r.name})`);
  console.log('\nREMOVE (deactivate mapping):');
  for (const r of remove) console.log(`  ${r.mappingId}  (${r.name})`);

  if (!apply) {
    console.log('\nDry-run — re-run with --apply to write.');
    process.exit(0);
  }

  // --- BIND ----------------------------------------------------------------
  let bound = 0;
  for (const r of bind) {
    try {
      const res = await bindMappingToEan(r.mappingId, r.confirmEan);
      bound++;
      console.log(`✓ ${r.mappingId} → ${r.confirmEan} (merged=${res.merged}, removedOrphan=${res.removedOrphanMaster})`);
    } catch (err) {
      console.error(`✗ ${r.mappingId} → ${r.confirmEan}: ${(err as Error).message}`);
    }
  }

  // --- REMOVE --------------------------------------------------------------
  let deactivated = 0;
  for (const r of remove) {
    const { error } = await db
      .from('supermarket_products')
      .update({ is_active: false })
      .eq('id', r.mappingId)
      .eq('is_active', true);
    if (error) {
      console.error(`✗ deactivate ${r.mappingId}: ${error.message}`);
      continue;
    }
    deactivated++;
  }

  console.log(`\nDone. Bound ${bound}/${bind.length}, deactivated ${deactivated}/${remove.length}.`);
  if (bound > 0) {
    console.log('\nBinding already enriched the master rows from the catalog. If any bound EAN was');
    console.log('a brand-new extra, also run:  npx tsx --env-file=.env scripts/seed-taxonomy.ts --apply');
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
