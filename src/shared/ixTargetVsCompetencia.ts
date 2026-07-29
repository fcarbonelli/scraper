/**
 * Client "IX TARGET vs COMPETENCIA" reference data.
 *
 * Sourced from the client's "Estructura Base" workbook, sheet "IX Target"
 * (columns EAN + "IX TARGET vs COMPETENCIA"). Pure reference data keyed by
 * barcode — same shape/approach as suplencias.ts / pesoEnCategoria.ts /
 * nuevaCategorizacion.ts — hardcoded here and stamped onto both client outputs
 * (the JSON pricing API and the .xlsx/.csv export) by EAN. The source sheet
 * repeats each EAN many times; duplicates were collapsed (last-wins).
 *
 * Used by:
 *   - src/api/lib/clientPricing.ts    (adds IX_TARGET_VS_COMPETENCIA to each item)
 *   - src/api/lib/exportClientBase.ts (adds the IX_TARGET_VS_COMPETENCIA column)
 */

/** EAN → "IX TARGET vs COMPETENCIA" value (as provided by the client). */
export const IX_TARGET_VS_COMPETENCIA_BY_EAN = new Map<string, string>([
  ["7793253005498", "100"],
  ["7793253003500", "100"],
  ["7790132098459", "120"],
  ["7793253005283", "95"],
  ["7793253005313", "90"],
  ["7793253005054", "85"],
  ["7793253003234", "100"],
  ["7793253003258", "100"],
  ["7793253004231", "100"],
  ["7793253003791", "100"],
  ["7793253003524", "100"],
  ["7793253003517", "100"],
  ["7793253006709", "120"],
  ["7793253004699", "110"],
  ["7793253005122", "85"],
  ["7793253001186", "100"],
  ["7793253005726", "85"],
  ["7793253005153", "85"],
  ["7793253006808", "87"],
  ["7793253005146", "85"],
  ["7793253005276", "95"],
  ["7793253005290", "95"],
  ["7793253006792", "87"],
  ["7793253004705", "110"],
  ["7793253005306", "90"],
  ["7793253400163", "90"],
]);

/** IX_TARGET_VS_COMPETENCIA for an EAN, or '' when the client didn't provide one. */
export function ixTargetVsCompetenciaFor(ean: string | null | undefined): string {
  if (!ean) return '';
  return IX_TARGET_VS_COMPETENCIA_BY_EAN.get(ean) ?? '';
}
