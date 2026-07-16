/**
 * Triage the EAN-less products that still reach the client.
 *
 * CONTEXT
 * -------
 * Some scraped products have NO barcode at all (the site never published one, or
 * the page parse failed). With no EAN we can't match them to the client catalog,
 * so their EAN / Categoria / Marca … cells export blank. This script triages ONLY
 * the ones that actually reach the client (active mapping under an active chain —
 * i.e. what client_base shows after migration 008); paused chains/mappings are
 * already hidden and ignored here.
 *
 * Each visible EAN-less mapping is bucketed:
 *   - REMOVE  → junk we can drop outright, no review needed:
 *       · placeholder name ("Unknown product" / blank) — failed parse, and
 *       · out-of-scope brands (JUNK_BRANDS below, e.g. pet food, non-catalog lines).
 *     REMOVE = deactivate the mapping (is_active=false): drops out of client_base,
 *     stops being scraped, reversible, price history retained. Same semantics as
 *     the "fuera_de_catalogo" removals from import-completed.ts.
 *   - REVIEW  → a real, named product from a brand we might track but with no EAN.
 *     These need a human call: bind the correct catalog EAN (heals it) or drop it
 *     if it's an untracked size/variant. We write them to an .xlsx with a
 *     PRE-FILLED suggested EAN (same matcher as heal-eans) for the operator/client
 *     to confirm, then feed the returned file to import-noean.ts.
 *
 * Reuses the shared matcher (src/discovery/eanMatch.ts). Read-only until --apply.
 *
 *   npx tsx --env-file=.env scripts/prune-noean.ts            # dry-run (plan only)
 *   npx tsx --env-file=.env scripts/prune-noean.ts --apply    # deactivate junk + write sheet
 *   npx tsx --env-file=.env scripts/prune-noean.ts --apply --out "C:\path\file.xlsx"
 */

import ExcelJSmod from 'exceljs';
import { db } from '../src/shared/db.js';
import { logger } from '../src/shared/logger.js';
import { buildEanIndex, suggestEansFromIndex, isPlaceholderName } from '../src/discovery/eanMatch.js';

const ExcelJS = (ExcelJSmod as unknown as { default?: typeof import('exceljs') }).default ?? ExcelJSmod;

/**
 * Brands/product lines that are out of scope for this catalog (cleaning &
 * household). Matched case-insensitively as a substring against brand AND name.
 * Keep this list small and explicit — anything not matched goes to REVIEW.
 */
const JUNK_BRANDS = ['jardin', 'harper', 'criadores'];

interface ProductRow { id: string; name: string | null; brand: string | null }
interface SmpRow {
  id: string;
  product_id: string;
  supermarket_id: string;
  is_active: boolean;
  external_url: string | null;
}
interface SupRow { id: string; is_active: boolean; cadena_display_name: string | null; name: string }

/** Page through a table so we never hit Supabase's 1000-row cap. */
async function fetchAll<T>(table: string, columns: string, orderBy: string): Promise<T[]> {
  const pageSize = 1000;
  const all: T[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await db
      .from(table)
      .select(columns)
      .order(orderBy, { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    const rows = (data ?? []) as unknown as T[];
    all.push(...rows);
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

/** A single EAN-less mapping visible to the client, plus its triage verdict. */
interface Unit {
  mappingId: string;
  chain: string;
  name: string;
  brand: string;
  url: string;
  verdict: 'remove' | 'review';
  reason: string;
  suggestedEan: string;
  suggestedDesc: string;
  confidence: string;
}

function classify(name: string, brand: string): { verdict: 'remove' | 'review'; reason: string } {
  if (isPlaceholderName(name)) return { verdict: 'remove', reason: 'placeholder (failed parse)' };
  const hay = `${brand} ${name}`.toLowerCase();
  const hit = JUNK_BRANDS.find((b) => hay.includes(b));
  if (hit) return { verdict: 'remove', reason: `out-of-scope (${hit})` };
  return { verdict: 'review', reason: 'named catalog-brand product, no EAN' };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const outIdx = args.indexOf('--out');
  const today = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
  const outPath =
    outIdx >= 0 && args[outIdx + 1]
      ? args[outIdx + 1]!
      : `C:\\Users\\fran-\\Downloads\\no_ean_a_revisar_${today}.xlsx`;

  const [mappings, supermarkets, index] = await Promise.all([
    fetchAll<SmpRow>('supermarket_products', 'id, product_id, supermarket_id, is_active, external_url', 'product_id'),
    fetchAll<SupRow>('supermarkets', 'id, is_active, cadena_display_name, name', 'id'),
    buildEanIndex(),
  ]);

  // Master products with no EAN (the orphans we care about).
  const { data: noEanRows, error: neErr } = await db.from('products').select('id, name, brand').is('ean', null);
  if (neErr) throw neErr;
  const noEanIds = new Set<string>();
  const prodById = new Map<string, ProductRow>();
  for (const p of (noEanRows ?? []) as ProductRow[]) {
    noEanIds.add(p.id);
    prodById.set(p.id, p);
  }

  const supById = new Map(supermarkets.map((s) => [s.id, s]));

  // Client-visible EAN-less mappings only (active mapping + active chain).
  const units: Unit[] = [];
  for (const m of mappings) {
    if (!m.is_active) continue;
    const sup = supById.get(m.supermarket_id);
    if (!sup || !sup.is_active) continue;
    if (!noEanIds.has(m.product_id)) continue;
    const p = prodById.get(m.product_id)!;
    const name = p.name ?? '';
    const brand = p.brand ?? '';
    const { verdict, reason } = classify(name, brand);

    let suggestedEan = '';
    let suggestedDesc = '';
    let confidence = '';
    if (verdict === 'review') {
      const top = suggestEansFromIndex(index, { name, brand, url: m.external_url }, 1)[0];
      if (top) {
        suggestedEan = top.ean;
        suggestedDesc = top.description;
        confidence = top.confidence;
      }
    }

    units.push({
      mappingId: m.id,
      chain: sup.cadena_display_name ?? sup.name.toUpperCase(),
      name,
      brand,
      url: m.external_url ?? '',
      verdict,
      reason,
      suggestedEan,
      suggestedDesc,
      confidence,
    });
  }

  const remove = units.filter((u) => u.verdict === 'remove');
  const review = units.filter((u) => u.verdict === 'review').sort((a, b) => a.chain.localeCompare(b.chain));

  console.log(`\nClient-visible EAN-less mappings: ${units.length}`);
  console.log(`  REMOVE (deactivate now): ${remove.length}`);
  console.log(`  REVIEW (→ sheet):        ${review.length}\n`);

  console.log('REMOVE:');
  for (const u of remove) console.log(`  [${u.chain}] ${u.brand ? u.brand + ' — ' : ''}${u.name || '(no name)'}  · ${u.reason}`);
  console.log('\nREVIEW (suggested EAN pre-filled where confident):');
  for (const u of review) {
    console.log(`  [${u.chain}] ${u.brand ? u.brand + ' — ' : ''}${u.name}`);
    console.log(`      → ${u.suggestedEan || '(no suggestion)'} (${u.confidence || 'n/a'}) ${u.suggestedDesc}`);
  }

  if (!apply) {
    console.log('\nDry-run — re-run with --apply to deactivate the REMOVE set and write the review sheet.');
    process.exit(0);
  }

  // --- Deactivate the REMOVE set -------------------------------------------
  let deactivated = 0;
  for (const u of remove) {
    const { error } = await db
      .from('supermarket_products')
      .update({ is_active: false })
      .eq('id', u.mappingId)
      .eq('is_active', true);
    if (error) {
      console.error(`  deactivate failed ${u.mappingId}:`, error.message);
      continue;
    }
    deactivated++;
  }
  logger.info({ deactivated }, 'prune-noean deactivated junk EAN-less mappings');
  console.log(`\nDeactivated ${deactivated}/${remove.length} junk mappings.`);

  // --- Write the REVIEW sheet ----------------------------------------------
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('No EAN a revisar');
  ws.columns = [
    { header: 'MAPPING_ID', key: 'mappingId', width: 38 },
    { header: 'Cadena', key: 'chain', width: 18 },
    { header: 'Marca', key: 'brand', width: 16 },
    { header: 'Descripcion_Sitio', key: 'name', width: 48 },
    { header: 'URL', key: 'url', width: 60 },
    { header: 'EAN_SUGERIDO', key: 'suggestedEan', width: 16 },
    { header: 'SUGERENCIA', key: 'suggestedDesc', width: 40 },
    { header: 'CONFIANZA', key: 'confidence', width: 12 },
    // Operator/client edits these two:
    { header: 'EAN_CONFIRMAR', key: 'confirmEan', width: 16 },
    { header: 'ACCION', key: 'accion', width: 14 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  for (const u of review) {
    ws.addRow({
      mappingId: u.mappingId,
      chain: u.chain,
      brand: u.brand,
      name: u.name,
      url: u.url,
      suggestedEan: u.suggestedEan,
      suggestedDesc: u.suggestedDesc,
      confidence: u.confidence,
      // Pre-fill the confirm cell only for high-confidence suggestions.
      confirmEan: u.confidence === 'high' ? u.suggestedEan : '',
      accion: '',
    });
  }
  await wb.xlsx.writeFile(outPath);
  console.log(`\nWrote ${review.length} rows to review → ${outPath}`);
  console.log('Fill EAN_CONFIRMAR (to bind) or write "eliminar" in ACCION (to drop), then:');
  console.log(`  npx tsx --env-file=.env scripts/import-noean.ts "${outPath}" --apply`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
