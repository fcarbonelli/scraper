/**
 * Client "PESO PRODUCTO EN CATEGORÍA" reference data.
 *
 * Sourced from the client's weekly pricing workbook (e.g. "pricing semana
 * 26.xlsx"), column "PESO PRODUCTO EN CATEGORÍA": the share/weight (0..1) of
 * each product within its category. Only a subset of EANs is tagged; the rest
 * come back empty.
 *
 * Pure reference data keyed by barcode — same shape/approach as
 * `suplencias.ts` and `taxonomy.ts` — so we hardcode it here and stamp it onto
 * both client outputs (the JSON pricing API and the .xlsx/.csv export) by EAN.
 *
 * Used by:
 *   - src/api/lib/clientPricing.ts    (adds PESO_PRODUCTO_EN_CATEGORIA to each item)
 *   - src/api/lib/exportClientBase.ts (adds the PESO_PRODUCTO_EN_CATEGORIA column)
 */

/**
 * EAN → weight of the product within its category (a ratio, typically 0..1).
 * The client provides these in Argentine format (e.g. "0,22"); stored here as
 * plain numbers so the xlsx export writes real numeric cells.
 */
export const PESO_EN_CATEGORIA_BY_EAN = new Map<string, number>([
  ['7793253005467', 0.22],
  ['7793253005238', 0.05],
  ['7793253003500', 0.64],
  ['7790132098459', 0.36],
  ['7793253004774', 0.37],
  ['7793253038526', 0.1],
  ['7793253005283', 0.13],
  ['7793253000516', 0.17],
  ['7793253005313', 0.13],
  ['7793253003715', 0.08],
  ['7793253005054', 0.18],
  ['7793253003234', 0.28],
  ['7793253003258', 0.14],
  ['7793253004231', 0.82],
  ['7793253003791', 0.2],
  ['7793253003722', 0.08],
  ['7793253003524', 0.11],
  ['7793253038106', 0.26],
  ['7793253003517', 0.21],
  ['7793253006709', 0.21],
  ['7793253004699', 0.02],
  ['7793253005122', 0.15],
  ['7793253002565', 0.03],
  ['7793253001186', 0.15],
  ['7793253000509', 0.08],
  ['7793253386160', 0.18],
  ['7793253005726', 0.15],
  ['7793253005153', 0.61],
  ['7793253006808', 0.46],
  ['7793253000349', 0.06],
  ['7793253006716', 0.06],
  ['7793253005221', 0.05],
  ['7793253000363', 0.07],
  ['7793253385712', 0.07],
  ['7793253005146', 0.09],
  ['7793253005276', 0.1],
  ['7793253005290', 0.06],
  ['7793253006792', 0.54],
  ['7793253002589', 0.03],
  ['7793253004705', 0.01],
  ['7793253005306', 0.09],
  ['7793253400163', 0.05],
  ['7793253005474', 0.12],
  ['7793253004712', 0.01],
]);

/**
 * Category weight for an EAN, or null for products the client didn't tag (so
 * both outputs get an empty cell for those rows).
 */
export function pesoEnCategoriaFor(ean: string | null | undefined): number | null {
  if (!ean) return null;
  return PESO_EN_CATEGORIA_BY_EAN.get(ean) ?? null;
}
