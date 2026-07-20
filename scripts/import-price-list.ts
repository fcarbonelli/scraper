/**
 * Import the client's Price List ("Lista de Precios") into `price_targets`.
 *
 * The client periodically sends an .xlsx whose "Listas de Precio" sheet holds a
 * target price (EDP) per EAN per commercial channel (SPM, MAY, MAY REG, PRO,
 * DISTRI). This script reads that sheet and upserts every (ean, canal) row into
 * `price_targets`, which the `client_base` view joins to fill PRECIO_TGT_SPM /
 * PRECIO_TGT_MAY in the export (see migration 012).
 *
 * Idempotent: re-running with an updated file overwrites each (ean, canal) with
 * the latest values. Safe to run on every new price list the client sends.
 *
 * Usage (PowerShell drops `--` in `npm run`, so call tsx directly):
 *   npx tsx --env-file=.env scripts/import-price-list.ts "<path-to.xlsx>" [--sheet="Listas de Precio"] [--dry-run]
 *   npm run lp:import -- "<path-to.xlsx>"          (bash/macOS/Linux)
 */

import ExcelJSimport from 'exceljs';
import { db } from '../src/shared/db.js';

// exceljs ships as CommonJS; the real module sits on `.default` under interop.
const ExcelJS = (ExcelJSimport as unknown as { default?: typeof import('exceljs') }).default
  ?? (ExcelJSimport as unknown as typeof import('exceljs'));

interface Args {
  file: string;
  sheet: string;
  dryRun: boolean;
}

/** Parse CLI args: first non-flag is the file path; flags override defaults. */
function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let file = '';
  let sheet = 'Listas de Precio';
  let dryRun = false;
  for (const a of argv) {
    if (a === '--dry-run') dryRun = true;
    else if (a.startsWith('--sheet=')) sheet = a.slice('--sheet='.length).replace(/^"|"$/g, '');
    else if (!a.startsWith('--')) file = a.replace(/^"|"$/g, '');
  }
  if (!file) {
    console.error('Usage: tsx scripts/import-price-list.ts "<path-to.xlsx>" [--sheet=...] [--dry-run]');
    process.exit(1);
  }
  return { file, sheet, dryRun };
}

/** Coerce an Excel cell to a number, tolerating strings with thousands/decimals. */
function toNumber(text: string): number | null {
  const s = text.trim();
  if (!s) return null;
  // Strip spaces and thousands separators; treat comma as decimal if no dot.
  const normalized = s.includes(',') && !s.includes('.')
    ? s.replace(/\./g, '').replace(',', '.')
    : s.replace(/,/g, '');
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

/** A row destined for the price_targets table. */
interface TargetRow {
  ean: string;
  canal: string;
  edp: number | null;
  precio_regular_caja: number | null;
  precio_unitario: number | null;
  codigo_lista: string | null;
  vigencia: string | null;
  anio: number | null;
  mes: string | null;
}

async function main() {
  const args = parseArgs();
  console.log(`Reading ${args.file} (sheet "${args.sheet}")${args.dryRun ? ' [DRY RUN]' : ''}`);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(args.file);
  const ws = wb.getWorksheet(args.sheet);
  if (!ws) {
    console.error(`Sheet "${args.sheet}" not found. Available: ${wb.worksheets.map((w) => w.name).join(', ')}`);
    process.exit(1);
  }

  // Resolve columns by header name (row 1) so we survive column reordering.
  const headerRow = ws.getRow(1);
  const col: Record<string, number> = {};
  headerRow.eachCell({ includeEmpty: true }, (cell, c) => {
    col[cell.text.trim().toLowerCase()] = c;
  });
  const find = (...names: string[]): number => {
    for (const n of names) {
      const c = col[n.toLowerCase()];
      if (c) return c;
    }
    return -1;
  };
  const cEan = find('ean');
  const cCanal = find('canal');
  const cEdp = find('edp');
  const cCaja = find('precio regular caja (sin iva)', 'precio regular caja');
  const cUnit = find('precio unitario (sin iva)', 'precio unitario');
  const cLista = find('código lista', 'codigo lista');
  const cVig = find('vigencia lp', 'vigencia');
  const cAnio = find('año', 'ano', 'anio');
  const cMes = find('mes');

  if (cEan < 0 || cCanal < 0 || cEdp < 0) {
    console.error('Missing required columns (need at least: EAN, Canal, EDP).');
    process.exit(1);
  }

  // Dedup on (ean, canal): the last occurrence in the file wins.
  const byKey = new Map<string, TargetRow>();
  let skipped = 0;
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const ean = String(row.getCell(cEan).text).trim();
    const canal = String(row.getCell(cCanal).text).trim();
    if (!ean || !canal) {
      skipped++;
      continue;
    }
    // Vigencia comes through as a Date; keep just the calendar day.
    const vigCell = row.getCell(cVig).value;
    const vigencia = vigCell instanceof Date ? vigCell.toISOString().slice(0, 10) : null;

    byKey.set(`${ean}|${canal}`, {
      ean,
      canal,
      edp: toNumber(String(row.getCell(cEdp).text)),
      precio_regular_caja: cCaja > 0 ? toNumber(String(row.getCell(cCaja).text)) : null,
      precio_unitario: cUnit > 0 ? toNumber(String(row.getCell(cUnit).text)) : null,
      codigo_lista: cLista > 0 ? String(row.getCell(cLista).text).trim() || null : null,
      vigencia,
      anio: cAnio > 0 ? toNumber(String(row.getCell(cAnio).text)) : null,
      mes: cMes > 0 ? String(row.getCell(cMes).text).trim() || null : null,
    });
  }

  const rows = [...byKey.values()];
  const canalCounts = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.canal] = (acc[r.canal] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`Parsed ${rows.length} (ean, canal) rows (skipped ${skipped} blank).`);
  console.log('Per canal:', canalCounts);

  if (args.dryRun) {
    console.log('Dry run — nothing written. Sample rows:');
    console.log(rows.slice(0, 5));
    return;
  }

  // Upsert in batches, keyed on the (ean, canal) primary key.
  const batchSize = 500;
  let written = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const { error } = await db.from('price_targets').upsert(batch, { onConflict: 'ean,canal' });
    if (error) throw error;
    written += batch.length;
    console.log(`  upserted ${written}/${rows.length}`);
  }

  // Report how many will actually light up in the export (EAN in our catalog).
  const { data: prods, error: prodErr } = await db.from('products').select('ean').not('ean', 'is', null);
  if (prodErr) throw prodErr;
  const ourEans = new Set((prods ?? []).map((p) => String((p as { ean: string }).ean).trim()));
  const matched = new Set(rows.filter((r) => ourEans.has(r.ean)).map((r) => r.ean));
  console.log(`Done. ${written} rows upserted; ${matched.size} distinct EANs match our catalog (will appear in the export).`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
