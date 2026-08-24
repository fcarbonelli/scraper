/**
 * Column list + CSV renderer for the in-store relevamiento download.
 *
 * Kept free of DB/ExcelJS so unit tests can import it without env vars.
 */

/** One column of the relevamiento workbook. `key` is the row field. */
export interface ExportColumn {
  key: string;
  header: string;
}

/**
 * Columns match the review-tab fields (plus visit location and review
 * status) so the downloaded file is the same data the operator sees,
 * just flattened.
 */
export const INSTORE_EXPORT_COLUMNS: ExportColumn[] = [
  { key: 'fecha', header: 'Fecha' },
  { key: 'cadena', header: 'Cadena' },
  { key: 'provincia', header: 'Provincia' },
  { key: 'localidad', header: 'Localidad' },
  { key: 'direccion', header: 'Direccion' },
  { key: 'relevador', header: 'Relevador' },
  { key: 'ean', header: 'EAN' },
  { key: 'producto', header: 'Producto' },
  { key: 'marca', header: 'Marca' },
  { key: 'precio_regular', header: 'Precio_Regular' },
  { key: 'precio_mayorista', header: 'Precio_Mayorista' },
  { key: 'unidades_mayorista', header: 'Unidades_Mayorista' },
  { key: 'sin_precio', header: 'Sin_precio' },
  { key: 'observaciones', header: 'Observaciones' },
  { key: 'estado_revision', header: 'Estado_revision' },
  { key: 'visit_id', header: 'Visit_id' },
  { key: 'entry_id', header: 'Entry_id' },
];

export type InStoreExportRow = Record<string, unknown>;

/** Quote a CSV cell only when it contains a delimiter, quote, or newline. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** UTF-8 CSV with a leading BOM so Excel keeps accents. */
export function toInStoreCsv(rows: InStoreExportRow[]): string {
  const lines: string[] = [];
  lines.push(INSTORE_EXPORT_COLUMNS.map((c) => csvCell(c.header)).join(','));
  for (const row of rows) {
    lines.push(INSTORE_EXPORT_COLUMNS.map((c) => csvCell(row[c.key])).join(','));
  }
  return '\uFEFF' + lines.join('\r\n');
}
