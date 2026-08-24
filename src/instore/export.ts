/**
 * Excel / CSV download of an in-store relevamiento (back-office).
 *
 * Powers `GET /v1/in-store/review/export`. This is NOT the client_base
 * pricing file — it's the raw field-worker dump (who typed what, where,
 * with visit location) so operators can archive a day's PDV work or
 * share it with the client.
 *
 * Rows are gathered up front (paged past PostgREST's 1000-row cap) so a
 * query error surfaces as JSON instead of a half-written download.
 */

import type { Response } from 'express';
import { db, fetchAllPages } from '../shared/db.js';
import { ApiError } from '../api/lib/apiError.js';
import { baDateRangeUtc, buenosAiresDate } from './dates.js';
import {
  INSTORE_EXPORT_COLUMNS,
  toInStoreCsv,
  type InStoreExportRow,
} from './exportFormat.js';

export {
  INSTORE_EXPORT_COLUMNS,
  toInStoreCsv,
  type ExportColumn,
  type InStoreExportRow,
} from './exportFormat.js';

export interface InStoreExportFilters {
  /** Inclusive Buenos Aires start day (YYYY-MM-DD). */
  from: string;
  /** Inclusive Buenos Aires end day (YYYY-MM-DD). */
  to: string;
  supermarketId?: string;
  visitId?: string;
  reviewStatus?: 'pending' | 'approved' | 'rejected';
}

interface EntryJoinRow {
  id: string;
  visit_id: string | null;
  supermarket_id: string;
  ean: string;
  product_name: string | null;
  price: number | null;
  no_price: boolean;
  promo_price: number | null;
  promo_min_units: number | null;
  note: string | null;
  entered_by: string;
  review_status: string;
  created_at: string;
  products: { name: string | null; brand: string | null } | { name: string | null; brand: string | null }[] | null;
  supermarkets: { name: string; cadena_display_name: string | null } | { name: string; cadena_display_name: string | null }[] | null;
  instore_visits:
    | { provincia: string | null; localidad: string | null; direccion: string | null }
    | { provincia: string | null; localidad: string | null; direccion: string | null }[]
    | null;
}

function firstJoin<T>(v: T | T[] | null | undefined): T | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

/** Flatten a DB row into the workbook's column keys. */
function toExportRow(r: EntryJoinRow): InStoreExportRow {
  const product = firstJoin(r.products);
  const store = firstJoin(r.supermarkets);
  const visit = firstJoin(r.instore_visits);
  return {
    fecha: buenosAiresDate(new Date(r.created_at)),
    cadena: store?.cadena_display_name ?? store?.name ?? r.supermarket_id,
    provincia: visit?.provincia ?? null,
    localidad: visit?.localidad ?? null,
    direccion: visit?.direccion ?? null,
    relevador: r.entered_by,
    ean: r.ean,
    producto: product?.name ?? r.product_name ?? null,
    marca: product?.brand ?? null,
    precio_regular: r.no_price ? null : r.price,
    precio_mayorista: r.no_price ? null : r.promo_price,
    unidades_mayorista: r.no_price ? null : r.promo_min_units,
    sin_precio: r.no_price ? 'si' : '',
    observaciones: r.note,
    estado_revision: r.review_status,
    visit_id: r.visit_id,
    entry_id: r.id,
  };
}

/**
 * Load every matching in-store entry as export rows, newest first.
 * `visit_id` ignores the date window (a visit can span midnight).
 */
export async function fetchInStoreExportRows(
  filters: InStoreExportFilters,
): Promise<InStoreExportRow[]> {
  const rows = await fetchAllPages<EntryJoinRow>((from, to) => {
    let query = db
      .from('instore_price_entries')
      .select(
        'id, visit_id, supermarket_id, ean, product_name, price, no_price, promo_price, promo_min_units, note, entered_by, review_status, created_at, products(name, brand), supermarkets(name, cadena_display_name), instore_visits(provincia, localidad, direccion)',
      )
      .order('created_at', { ascending: false })
      .range(from, to);

    if (filters.visitId) {
      query = query.eq('visit_id', filters.visitId);
    } else {
      const { fromUtc, toUtc } = baDateRangeUtc(filters.from, filters.to);
      query = query.gte('created_at', fromUtc).lt('created_at', toUtc);
    }
    if (filters.supermarketId) query = query.eq('supermarket_id', filters.supermarketId);
    if (filters.reviewStatus) query = query.eq('review_status', filters.reviewStatus);
    return query;
  });

  return rows.map(toExportRow);
}

/**
 * Stream rows as a real .xlsx workbook. ExcelJS is loaded lazily so a
 * missing package becomes a JSON error instead of a broken download.
 */
export async function writeInStoreXlsx(
  res: Response,
  rows: InStoreExportRow[],
  filenameBase: string,
): Promise<void> {
  let ExcelJS: typeof import('exceljs');
  try {
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
  const sheet = workbook.addWorksheet('relevamiento_presencial');

  sheet.addRow(INSTORE_EXPORT_COLUMNS.map((c) => c.header)).commit();
  for (const row of rows) {
    sheet.addRow(INSTORE_EXPORT_COLUMNS.map((c) => row[c.key] ?? null)).commit();
  }

  await sheet.commit();
  await workbook.commit();
}
