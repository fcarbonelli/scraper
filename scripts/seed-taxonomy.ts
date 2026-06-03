/**
 * Enrich existing products with client taxonomy data.
 *
 * Reads the TAXONOMY_BY_EAN reference and updates products that already
 * exist in the DB with the client's official category, subcategory,
 * manufacturer, brand, format, variety, and description_forms fields.
 *
 * Does NOT create products — the URL-based ingest workflow handles that.
 * Products not yet in the DB are silently skipped (they'll be enriched
 * automatically when added via URL later, through the ingest module).
 *
 * Idempotent — safe to re-run after adding new products.
 *
 * Usage:
 *   npx tsx scripts/seed-taxonomy.ts
 */

import { db } from '../src/shared/db.js';
import { logger } from '../src/shared/logger.js';
import { TAXONOMY_BY_EAN } from '../src/shared/taxonomy.js';

async function main(): Promise<void> {
  let updated = 0;
  let skipped = 0;
  let notFound = 0;

  for (const [ean, tax] of TAXONOMY_BY_EAN) {
    // Find products with this EAN
    const { data: products, error: findErr } = await db
      .from('products')
      .select('id')
      .eq('ean', ean);

    if (findErr) {
      logger.error({ err: findErr, ean }, 'failed to query product by EAN');
      continue;
    }

    if (!products || products.length === 0) {
      notFound++;
      continue;
    }

    for (const product of products) {
      const { error: updateErr } = await db
        .from('products')
        .update({
          category: tax.category,
          subcategory: tax.subcategory,
          manufacturer: tax.manufacturer,
          brand: tax.brand,
          format: tax.format || null,
          variety: tax.variety || null,
          description_forms: tax.descriptionForms || null,
        })
        .eq('id', product.id);

      if (updateErr) {
        logger.error({ err: updateErr, ean, productId: product.id }, 'failed to update product');
        skipped++;
        continue;
      }
      updated++;
    }
  }

  logger.info(
    { updated, skipped, notFound, totalEans: TAXONOMY_BY_EAN.size },
    'taxonomy seed complete',
  );
}

void main();
