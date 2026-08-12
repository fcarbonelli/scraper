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
import { db, fetchAllPages } from '../../shared/db.js';
import { ApiError } from './apiError.js';
import { suplenciaFor } from '../../shared/suplencias.js';
import { pesoEnCategoriaFor } from '../../shared/pesoEnCategoria.js';
import { nuevaCategorizacionFor } from '../../shared/nuevaCategorizacion.js';
import { ixTargetVsCompetenciaFor } from '../../shared/ixTargetVsCompetencia.js';
import {
  diffVsEdp,
  idxVsCompetencia,
  buildAyudinPriceRef,
  ayudinEans,
} from '../../shared/priceIndicators.js';

/**
 * Client-facing data floor. The client only wants to see data from this date
 * onward — everything on/before 2026-07-30 is hidden from BOTH the pricing API
 * and the export. Applied as a `Fecha_Relevamiento >= floor` filter on every
 * client-facing query (kept here at the query layer, so we don't have to
 * recreate the whole client_base view just to add one WHERE condition).
 *
 * NB: combined with any caller `from`, Supabase applies both, so the effective
 * lower bound is always MAX(from, floor) — the floor can never be bypassed.
 */
export const CLIENT_DATA_FLOOR_DATE = '2026-07-31';

/** Filters shared by the pricing and export endpoints. */
export interface ClientBaseFilters {
  from?: string | undefined;
  to?: string | undefined;
  supermarket?: string | undefined;
  canal?: string | undefined;
  ean?: string | undefined;
  /**
   * Operator preview: read from `client_base_preview` (includes pending_review
   * days) instead of the published-only `client_base`. Lets an operator
   * download today's data BEFORE approving it. Never used by the client
   * pricing contract — export-only.
   */
  includeUnpublished?: boolean | undefined;
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
  // Hardcoded client reference (TITULAR/SUPLENTE/blank), stamped by EAN in
  // fetchAllClientBase — not a real column of the client_base view.
  { key: 'SUPLENCIAS', header: 'SUPLENCIAS' },
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
  // Wholesale target (LP 'MAY'), national wholesalers only. Renamed from the
  // old PRECIO_TGT_MAY (migration 023).
  { key: 'PRECIO_TGT_WHS', header: 'PRECIO_TGT_WHS' },
  // Regional wholesale target (LP 'MAY REG'), regional wholesalers only.
  { key: 'PRECIO_TGT_WHS_REG', header: 'PRECIO_TGT_WHS_REG' },
  // Derived (stamped in fetchAllClientBase): Precio_Regular vs the EDP target,
  // as a whole-number percentage string ("23%"). Not a real client_base column.
  { key: 'DIFF_VS_EDP', header: 'DIFF_VS_EDP' },
  // Derived (stamped in fetchAllClientBase): competitor vs Ayudín price index.
  // The view exposes this column as NULL; we overwrite it with the computed %.
  { key: 'IDX_VS_COMPETENCIA', header: 'IDX_VS_COMPETENCIA' },
  // Hardcoded client reference (target-vs-competitor index), stamped by EAN in
  // fetchAllClientBase — not a real column of the client_base view.
  { key: 'IX_TARGET_VS_COMPETENCIA', header: 'IX_TARGET_VS_COMPETENCIA' },
  // Hardcoded client reference (category weight 0..1), stamped by EAN in
  // fetchAllClientBase — not a real column of the client_base view.
  { key: 'PESO_PRODUCTO_EN_CATEGORIA', header: 'PESO_PRODUCTO_EN_CATEGORIA' },
  // Hardcoded client "nueva categorización" code, stamped by EAN — likewise
  // not a real column of the client_base view.
  { key: 'NUEVA_CATEGORIZACION', header: 'NUEVA_CATEGORIZACION' },
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

  // Published-only client view by default; the preview view (which also
  // includes pending_review days) only when explicitly requested.
  const view = filters.includeUnpublished ? 'client_base_preview' : 'client_base';

  for (;;) {
    let query = db
      .from(view)
      .select('*')
      .order('Fecha_Relevamiento', { ascending: false })
      .order('ID', { ascending: false })
      .range(offset, offset + pageSize - 1);

    // Hard client-data floor (hide everything on/before 2026-07-30).
    query = query.gte('Fecha_Relevamiento', CLIENT_DATA_FLOOR_DATE);
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

    // Stamp the hardcoded reference columns onto each row by EAN so both the
    // xlsx and csv writers (which read row[c.key]) pick them up like any column.
    // PESO stays a number (or null) so the xlsx writes a real numeric cell.
    // DIFF_VS_EDP is per-row; IDX_VS_COMPETENCIA needs the cross-row Ayudín
    // reference and is stamped after the full window is loaded (below).
    for (const row of data as ClientBaseRow[]) {
      const ean = row['EAN'] == null ? '' : String(row['EAN']);
      row['SUPLENCIAS'] = suplenciaFor(ean);
      row['PESO_PRODUCTO_EN_CATEGORIA'] = pesoEnCategoriaFor(ean);
      row['NUEVA_CATEGORIZACION'] = nuevaCategorizacionFor(ean);
      row['IX_TARGET_VS_COMPETENCIA'] = ixTargetVsCompetenciaFor(ean);
      row['DIFF_VS_EDP'] = diffVsEdp(
        row['Precio_Regular'],
        row['PRECIO_TGT_SPM'],
        row['PRECIO_TGT_WHS'],
        row['PRECIO_TGT_WHS_REG'],
      );
    }

    all.push(...(data as ClientBaseRow[]));
    if (data.length < pageSize) break;
    offset += pageSize;
  }

  // IDX_VS_COMPETENCIA: each competitor (…_A1) row is divided by the Ayudín
  // (…_A) price in the SAME supermarket on the SAME date. We build the Ayudín
  // reference via a scoped query (NOT from `all`) so it stays correct even when
  // the caller filters by a single competitor EAN — which would otherwise leave
  // `all` without any Ayudín rows to compare against.
  const ayudinRef = await loadAyudinPriceRef(filters);
  for (const row of all) {
    row['IDX_VS_COMPETENCIA'] = idxVsCompetencia(row, ayudinRef);
  }

  return all;
}

/**
 * Load the Ayudín price reference (Map keyed by code|supermarket|date) used to
 * compute IDX_VS_COMPETENCIA. Queries the same view/window/supermarket/canal as
 * the caller but scoped to the Ayudín EAN set (ignoring any single-EAN filter,
 * which would otherwise exclude the reference product). Shared by the export
 * and the /pricing endpoint so both produce identical indices.
 */
export async function loadAyudinPriceRef(
  filters: ClientBaseFilters,
): Promise<Map<string, number>> {
  const eans = ayudinEans();
  if (eans.length === 0) return new Map();
  const view = filters.includeUnpublished ? 'client_base_preview' : 'client_base';

  const rows = await fetchAllPages<Record<string, unknown>>((from, to) => {
    let query = db
      .from(view)
      .select('ID, EAN, Cadena, Fecha_Relevamiento, Precio_Regular')
      .in('EAN', eans)
      .order('Fecha_Relevamiento', { ascending: false })
      .order('ID', { ascending: false })
      .range(from, to);
    // Same client-data floor as fetchAllClientBase so the Ayudín reference can't
    // pull a pre-floor price.
    query = query.gte('Fecha_Relevamiento', CLIENT_DATA_FLOOR_DATE);
    if (filters.from) query = query.gte('Fecha_Relevamiento', filters.from);
    if (filters.to) query = query.lte('Fecha_Relevamiento', filters.to);
    if (filters.canal) query = query.eq('Canal', filters.canal);
    if (filters.supermarket) {
      const ids = filters.supermarket.split(',').map((s) => s.trim()).filter(Boolean);
      const first = ids[0];
      if (ids.length === 1 && first) {
        query = query.eq('Cadena', first.toUpperCase());
      } else if (ids.length > 1) {
        query = query.in('Cadena', ids.map((id) => id.toUpperCase()));
      }
    }
    return query;
  });

  return buildAyudinPriceRef(rows);
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
