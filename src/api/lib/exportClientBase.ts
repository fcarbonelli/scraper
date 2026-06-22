/**
 * Export helpers for the client_base view.
 *
 * Powers `GET /v1/data/export`, which lets the client download a day's
 * (or a date range's) pricing data as a real .xlsx workbook or a CSV file.
 *
 * Design notes:
 *   - The column list mirrors the `client_base` SQL view exactly (same names,
 *     same order) so the downloaded file matches the JSON API 1:1.
 *   - We fetch ALL matching rows up front (paged in batches of 1000 to get
 *     past Supabase's default row cap) BEFORE writing any bytes. That way a
 *     query error throws cleanly as JSON instead of corrupting a half-written
 *     download stream.
 *   - xlsx is produced with ExcelJS's streaming WorkbookWriter so memory stays
 *     flat even as the catalog scales to thousands of rows per day.
 */

import type { Response } from 'express';
import { db } from '../../shared/db.js';
import { ApiError } from './apiError.js';

/** Filters shared by the pricing and export endpoints. */
export interface ClientBaseFilters {
  from?: string | undefined;
  to?: string | undefined;
  supermarket?: string | undefined;
  canal?: string | undefined;
  ean?: string | undefined;
}

/**
 * Columns of the `client_base` view, in the exact order the client expects.
 * `key` is the column name returned by Supabase; `header` is the label written
 * to the file's first row (kept identical to the column name on purpose).
 */
const COLUMNS: { key: string; header: string }[] = [
  { key: 'ID', header: 'ID' },
  { key: 'Fecha_Creacion', header: 'Fecha_Creacion' },
  { key: 'Fecha_Actualizacion', header: 'Fecha_Actualizacion' },
  { key: 'Provincia', header: 'Provincia' },
  { key: 'Zona', header: 'Zona' },
  { key: 'Mes', header: 'Mes' },
  { key: 'Semana', header: 'Semana' },
  { key: 'Fecha_Relevamiento', header: 'Fecha_Relevamiento' },
  { key: 'Canal', header: 'Canal' },
  { key: 'Cadena', header: 'Cadena' },
  { key: 'Categoria', header: 'Categoria' },
  { key: 'Subcategoria', header: 'Subcategoria' },
  { key: 'Fabricante', header: 'Fabricante' },
  { key: 'Marca', header: 'Marca' },
  { key: 'Formato', header: 'Formato' },
  { key: 'Variedad', header: 'Variedad' },
  { key: 'Descripcion_para_Forms', header: 'Descripcion_para_Forms' },
  { key: 'EAN', header: 'EAN' },
  { key: 'Desc_Sku_Sitio', header: 'Desc_Sku_Sitio' },
  { key: 'Estado', header: 'Estado' },
  { key: 'Precio_Regular', header: 'Precio_Regular' },
  { key: 'Precio_c_Oferta_1', header: 'Precio_c_Oferta_1' },
  { key: 'Precio_c_Oferta_2', header: 'Precio_c_Oferta_2' },
  { key: 'Promocion_1', header: 'Promocion_1' },
  { key: 'Promocion_2', header: 'Promocion_2' },
  { key: 'Descuento_Unitario', header: 'Descuento_Unitario' },
  { key: 'URL', header: 'URL' },
  { key: 'Precio_MasBajo', header: 'Precio_MasBajo' },
  { key: 'PRECIO_TGT_SPM', header: 'PRECIO_TGT_SPM' },
  { key: 'PRECIO_TGT_MAY', header: 'PRECIO_TGT_MAY' },
  { key: 'IDX_VS_COMPETENCIA', header: 'IDX_VS_COMPETENCIA' },
  { key: 'PRECIO_PRODUCTO_EN_CATEGORIA', header: 'PRECIO_PRODUCTO_EN_CATEGORIA' },
];

type ClientBaseRow = Record<string, unknown>;

/**
 * Today's date (YYYY-MM-DD) in Argentina time, used as the default export
 * window. We anchor to America/Argentina/Buenos_Aires so "daily data" lines up
 * with the local business day regardless of where the server runs.
 */
export function todayInBuenosAires(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
  }).format(new Date());
}

/**
 * Fetch every client_base row matching the given filters, paging past
 * Supabase's 1000-row response cap so the full day/range is returned.
 */
export async function fetchAllClientBase(
  filters: ClientBaseFilters,
): Promise<ClientBaseRow[]> {
  const pageSize = 1000;
  const all: ClientBaseRow[] = [];
  let offset = 0;

  for (;;) {
    let query = db
      .from('client_base')
      .select('*')
      .order('Fecha_Relevamiento', { ascending: false })
      .order('ID', { ascending: false })
      .range(offset, offset + pageSize - 1);

    if (filters.from) query = query.gte('Fecha_Relevamiento', filters.from);
    if (filters.to) query = query.lte('Fecha_Relevamiento', filters.to);
    if (filters.canal) query = query.eq('Canal', filters.canal);
    if (filters.ean) query = query.eq('EAN', filters.ean);
    if (filters.supermarket) {
      const ids = filters.supermarket.split(',').map((s) => s.trim()).filter(Boolean);
      const first = ids[0];
      if (ids.length === 1 && first) {
        query = query.eq('Cadena', first.toUpperCase());
      } else if (ids.length > 1) {
        query = query.in('Cadena', ids.map((id) => id.toUpperCase()));
      }
    }

    const { data, error } = await query;
    if (error) throw error;
    if (!data || data.length === 0) break;

    all.push(...(data as ClientBaseRow[]));
    if (data.length < pageSize) break;
    offset += pageSize;
  }

  return all;
}

/** Quote a CSV cell only when it contains a delimiter, quote, or newline. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Render rows as a UTF-8 CSV string. A leading BOM is included so Excel opens
 * the file with the correct encoding (accents like "ó" render properly).
 */
export function toCsv(rows: ClientBaseRow[]): string {
  const lines: string[] = [];
  lines.push(COLUMNS.map((c) => csvCell(c.header)).join(','));
  for (const row of rows) {
    lines.push(COLUMNS.map((c) => csvCell(row[c.key])).join(','));
  }
  return '\uFEFF' + lines.join('\r\n');
}

/**
 * Stream rows to the response as a real .xlsx workbook.
 *
 * ExcelJS is loaded lazily (dynamic import) so the whole API can still boot —
 * and CSV export still works — even if the optional `exceljs` dependency isn't
 * installed yet. We resolve the module BEFORE setting any response headers, so
 * a missing dependency surfaces as a clean JSON error instead of a broken,
 * half-written download. The WorkbookWriter writes the zip directly to `res`
 * and ends the stream on commit, keeping memory flat regardless of row count.
 */
export async function writeXlsx(
  res: Response,
  rows: ClientBaseRow[],
  filenameBase: string,
): Promise<void> {
  let ExcelJS: typeof import('exceljs');
  try {
    // exceljs ships as CommonJS: under esModuleInterop the real module sits on
    // `.default`, but its type only declares named exports (no `default`). Read
    // it via an optional cast and fall back to the namespace so this compiles
    // and runs regardless of the interop shape.
    const mod = await import('exceljs');
    ExcelJS = (mod as { default?: typeof import('exceljs') }).default ?? mod;
  } catch {
    throw new ApiError(
      'INTERNAL',
      "Excel export requires the 'exceljs' package. Run `npm install` to add it, " +
        'or request ?format=csv instead.',
    );
  }

  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.xlsx"`);

  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: res,
    useStyles: false,
    useSharedStrings: false,
  });
  const sheet = workbook.addWorksheet('client_base');

  sheet.addRow(COLUMNS.map((c) => c.header)).commit();
  for (const row of rows) {
    sheet.addRow(COLUMNS.map((c) => row[c.key] ?? null)).commit();
  }

  await sheet.commit();
  await workbook.commit();
}
