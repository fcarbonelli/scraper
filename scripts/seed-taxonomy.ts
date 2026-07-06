/**
 * Normalize existing products to the client's official taxonomy.
 *
 * The client standardized category/subcategory/brand/manufacturer/format/variety
 * and the "Descripcion_para_Forms" label per EAN in their reference sheet. The
 * export (client_base view) reads these straight off the `products` row, so the
 * master's columns MUST carry the client naming — not whatever a site happened
 * to scrape.
 *
 * This script re-stamps every product whose EAN is in the catalog (the UNION of
 * the hardcoded 211 + runtime `catalog_extra_eans`) with the canonical values,
 * overriding any scraped/stale data. New products are already enriched at ingest
 * time (src/ingest/index.ts); this fixes rows that predate enrichment, were
 * healed later, or were added before an extra EAN existed.
 *
 * For built-in EANs the reference is authoritative and complete, so all seven
 * columns are set (empty format/variety → NULL). For runtime EANs we only
 * overwrite the fields the operator actually filled in, so a blank field can't
 * clobber good data.
 *
 * Idempotent. Dry-run by default — pass --apply to write.
 *
 * Usage (PowerShell-safe — call tsx directly; npm eats the `--` flags):
 *   npx tsx --env-file=.env scripts/seed-taxonomy.ts            # preview diffs
 *   npx tsx --env-file=.env scripts/seed-taxonomy.ts --apply    # write
 */

import { db } from '../src/shared/db.js';
import { logger } from '../src/shared/logger.js';
import { getCatalogEans, isBuiltInEan } from '../src/shared/catalog.js';
import { MARCA_TO_FABRICANTE, type TaxonomyEntry } from '../src/shared/taxonomy.js';

/** Columns we mirror from the catalog onto the master row. */
const FIELDS = [
  'category',
  'subcategory',
  'manufacturer',
  'brand',
  'format',
  'variety',
  'description_forms',
] as const;
type Field = (typeof FIELDS)[number];

interface ProductRow {
  id: string;
  ean: string;
  name: string;
  category: string | null;
  subcategory: string | null;
  manufacturer: string | null;
  brand: string | null;
  format: string | null;
  variety: string | null;
  description_forms: string | null;
}

/** The canonical value for each column, from a catalog entry. */
function canonicalValues(tax: TaxonomyEntry): Record<Field, string | null> {
  return {
    category: tax.category || null,
    subcategory: tax.subcategory || null,
    manufacturer: tax.manufacturer || null,
    brand: tax.brand || null,
    format: tax.format || null,
    variety: tax.variety || null,
    description_forms: tax.descriptionForms || null,
  };
}

/**
 * Build the patch to bring `row` in line with the catalog. Returns only the
 * fields that actually differ (empty patch = already normalized). For runtime
 * (non-built-in) EANs, blank canonical fields are skipped so they can't wipe
 * existing data.
 */
function diffPatch(row: ProductRow, tax: TaxonomyEntry, builtin: boolean): Partial<Record<Field, string | null>> {
  const want = canonicalValues(tax);
  const patch: Partial<Record<Field, string | null>> = {};
  for (const f of FIELDS) {
    const target = want[f];
    if (!builtin && (target === null || target === '')) continue; // don't clobber with blanks
    if ((row[f] ?? null) !== target) patch[f] = target;
  }
  return patch;
}

/**
 * For a product whose EAN is NOT in the catalog we have no standardized naming,
 * so we only fill blanks from what we already have: Fabricante is derivable from
 * Marca via the brand→manufacturer map. Never overwrites an existing value.
 */
function nonCatalogFill(row: ProductRow): Partial<Record<Field, string | null>> {
  const patch: Partial<Record<Field, string | null>> = {};
  if (!row.manufacturer && row.brand) {
    const man = MARCA_TO_FABRICANTE[row.brand.trim().toUpperCase()];
    if (man) patch.manufacturer = man;
  }
  return patch;
}

/** Fetch all products with a non-null EAN, paging past the 1000-row cap. */
async function fetchAllProducts(): Promise<ProductRow[]> {
  const pageSize = 1000;
  const all: ProductRow[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await db
      .from('products')
      .select('id, ean, name, category, subcategory, manufacturer, brand, format, variety, description_forms')
      .not('ean', 'is', null)
      .order('ean', { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...(data as ProductRow[]));
    if (data.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

async function main(): Promise<void> {
  const apply = process.argv.slice(2).includes('--apply');

  const catalog = await getCatalogEans();
  const products = await fetchAllProducts();

  let inCatalog = 0;
  let alreadyOk = 0;
  let changedCatalog = 0;
  let filledNonCatalog = 0;
  let failed = 0;
  const samples: string[] = [];

  for (const row of products) {
    const tax = catalog.get(row.ean);
    const builtin = tax ? isBuiltInEan(row.ean) : false;

    // Catalog EANs get the full standardized naming; non-catalog EANs only get
    // blanks filled from what we already have (Fabricante from Marca).
    const patch = tax ? diffPatch(row, tax, builtin) : nonCatalogFill(row);

    if (tax) {
      inCatalog++;
      if (Object.keys(patch).length === 0) {
        alreadyOk++;
        continue;
      }
      changedCatalog++;
    } else {
      if (Object.keys(patch).length === 0) continue;
      filledNonCatalog++;
    }

    if (samples.length < 20) {
      const parts = Object.entries(patch).map(([k, v]) => `${k}: ${JSON.stringify(row[k as Field])}→${JSON.stringify(v)}`);
      samples.push(`  ${row.ean}  ${tax ? '' : '[non-catalog] '}${row.name}\n      ${parts.join(', ')}`);
    }

    if (apply) {
      const { error } = await db.from('products').update(patch).eq('id', row.id);
      if (error) {
        failed++;
        logger.error({ err: error, ean: row.ean, productId: row.id }, 'taxonomy update failed');
      }
    }
  }

  const total = changedCatalog + filledNonCatalog;
  console.log(`\nProducts with an EAN: ${products.length}`);
  console.log(`In catalog (built-in ∪ extras): ${inCatalog}  (${alreadyOk} already normalized)`);
  console.log(`${apply ? 'Normalized (catalog)' : 'Would normalize (catalog)'}: ${changedCatalog}`);
  console.log(`${apply ? 'Filled Fabricante (non-catalog)' : 'Would fill Fabricante (non-catalog)'}: ${filledNonCatalog}`);
  if (failed) console.log(`Failed: ${failed}`);
  if (samples.length) {
    console.log(`\nSample changes${apply ? '' : ' (dry-run — nothing written)'}:`);
    console.log(samples.join('\n'));
  }
  if (!apply && total > 0) {
    console.log('\nRe-run with --apply to write these values.');
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
