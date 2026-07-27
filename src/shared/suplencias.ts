/**
 * Client "SUPLENCIAS" reference data.
 *
 * Sourced from the client's "Productos (EAN)" sheet (Setup V3), column
 * SUPLENCIAS. For a subset of products the client flags each EAN as the
 * "TITULAR" (the primary/reference item in its group) or a "SUPLENTE" (a
 * stand-in/substitute). Products with no value are left blank.
 *
 * This is pure reference data keyed by barcode — the same shape as
 * `taxonomy.ts` — so we hardcode it here and stamp it onto both client
 * outputs (the JSON pricing API and the .xlsx/.csv export) by EAN.
 *
 * Used by:
 *   - src/api/lib/clientPricing.ts   (adds `Suplencias` to each PriceData item)
 *   - src/api/lib/exportClientBase.ts (adds the SUPLENCIAS column to the file)
 */

/** Allowed SUPLENCIAS values (empty string = no flag for that EAN). */
export type Suplencia = 'TITULAR' | 'SUPLENTE' | '';

/** EAN → SUPLENCIAS flag. Only EANs the client explicitly tagged appear here. */
export const SUPLENCIAS_BY_EAN = new Map<string, Suplencia>([
  ['7793253005054', 'TITULAR'],
  ['7793253005061', 'SUPLENTE'],
  ['7790520995285', 'TITULAR'],
  ['7790520995308', 'SUPLENTE'],
  ['7790520031020', 'TITULAR'],
  ['7790520031044', 'SUPLENTE'],
  ['7791290795778', 'TITULAR'],
  ['7791290795785', 'SUPLENTE'],
  ['7793253004231', 'TITULAR'],
  ['7793253004255', 'SUPLENTE'],
  ['7790520028730', 'TITULAR'],
  ['7790520028792', 'SUPLENTE'],
  ['7793253003715', 'TITULAR'],
  ['7793253003722', 'TITULAR'],
  ['7793253003739', 'TITULAR'],
  ['7793253003746', 'SUPLENTE'],
  ['7793253003753', 'SUPLENTE'],
  ['7793253003760', 'SUPLENTE'],
  ['7793253003791', 'TITULAR'],
  ['7793253003838', 'SUPLENTE'],
  ['7793253003807', 'SUPLENTE'],
  ['7793253005856', 'TITULAR'],
  ['7793253005863', 'SUPLENTE'],
  ['7793253003869', 'TITULAR'],
  ['7793253003876', 'SUPLENTE'],
  ['7791290794955', 'TITULAR'],
  ['7791290794962', 'SUPLENTE'],
  ['7793253003500', 'TITULAR'],
  ['7793253003548', 'SUPLENTE'],
  ['7793253003579', 'SUPLENTE'],
  ['7793253003517', 'TITULAR'],
  ['7793253003555', 'SUPLENTE'],
  ['7793253003586', 'SUPLENTE'],
  ['7793253003524', 'TITULAR'],
  ['7793253003562', 'SUPLENTE'],
  ['7791130683524', 'TITULAR'],
  ['7791130683661', 'SUPLENTE'],
  ['7791130683760', 'TITULAR'],
  ['7791130683784', 'SUPLENTE'],
  ['7790520996428', 'TITULAR'],
  ['7790520996381', 'SUPLENTE'],
  ['7790520996473', 'TITULAR'],
  ['7790520996466', 'SUPLENTE'],
  ['7793253004699', 'TITULAR'],
  ['7793253004729', 'SUPLENTE'],
  ['7793253004743', 'SUPLENTE'],
  ['7793253004705', 'TITULAR'],
  ['7793253004736', 'SUPLENTE'],
  ['7793253004750', 'SUPLENTE'],
  ['7790520995162', 'TITULAR'],
  ['7790520995186', 'TITULAR'],
  ['7790520995209', 'SUPLENTE'],
  ['7790520995216', 'SUPLENTE'],
  ['7891035000683', 'TITULAR'],
  ['7891035000690', 'SUPLENTE'],
  ['7793253007362', 'SUPLENTE'],
  ['7793253007393', 'SUPLENTE'],
  ['7793253007379', 'TITULAR'],
  ['7793253007409', 'TITULAR'],
  ['7793253007386', 'SUPLENTE'],
  ['7793253007416', 'SUPLENTE'],
  ['7794440994199', 'SUPLENTE'],
  ['7794440994205', 'TITULAR'],
  ['7794440994212', 'SUPLENTE'],
  ['7794440045419', 'SUPLENTE'],
  ['7794440045426', 'TITULAR'],
  ['7794440045433', 'SUPLENTE'],
  ['7798033332382', 'TITULAR'],
  ['7798033332399', 'SUPLENTE'],
  ['7798141719648', 'TITULAR'],
  ['7798141719655', 'SUPLENTE'],
  ['7798159712457', 'TITULAR'],
  ['7798159712440', 'SUPLENTE'],
  ['8480017243522', 'TITULAR'],
  ['8480017103338', 'SUPLENTE'],
]);

/**
 * SUPLENCIAS flag for an EAN. Returns '' for products the client didn't tag,
 * so both outputs get a blank cell (never null/undefined) for those rows.
 */
export function suplenciaFor(ean: string | null | undefined): Suplencia {
  if (!ean) return '';
  return SUPLENCIAS_BY_EAN.get(ean) ?? '';
}
