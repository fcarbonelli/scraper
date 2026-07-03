/**
 * Bind a supermarket_products mapping to a catalog EAN (and merge masters).
 *
 * WHY THIS EXISTS
 * ---------------
 * Chains that don't publish an EAN on their product pages (e.g. Coto) get
 * ingested as a master `products` row with `ean = NULL` and no taxonomy. That
 * row (a) exports with blank general columns (Categoria, Marca, …) and (b) never
 * dedupes with the "real" master that EAN-exposing chains created for the same
 * product — so you end up with two rows for one product, one complete and one
 * blank.
 *
 * Binding the correct catalog EAN fixes both at once: we re-point the mapping to
 * the canonical master for that EAN (creating + enriching it from the catalog
 * taxonomy if needed) and drop the now-orphaned blank master.
 *
 * HISTORY IS PRESERVED FOR FREE: price_snapshots key on `supermarket_product_id`
 * (the mapping), NOT on `product_id`, so re-pointing the mapping keeps the whole
 * price series intact — no snapshot migration required.
 */

import { db } from '../shared/db.js';
import { logger } from '../shared/logger.js';
import { lookupCatalog } from '../shared/catalog.js';
import type { TaxonomyEntry } from '../shared/taxonomy.js';

export interface BindEanResult {
  supermarketProductId: string;
  ean: string;
  /** The master this mapping now points at. */
  productId: string;
  /** True if the mapping was moved to a different (canonical) master. */
  merged: boolean;
  /** True if a now-empty orphan master row was deleted. */
  removedOrphanMaster: boolean;
  /** True if the canonical master was created by this call. */
  createdMaster: boolean;
}

/** Taxonomy columns we mirror onto the master row (client's source of truth). */
function taxonomyPatch(tax: TaxonomyEntry): Record<string, unknown> {
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
 * Find the canonical master for `ean`. Uses the first row if several share the
 * EAN (the schema allows duplicates) so this never throws on drifted data.
 */
async function findMasterByEan(
  ean: string,
): Promise<{ id: string; name: string } | null> {
  const { data, error } = await db
    .from('products')
    .select('id, name')
    .eq('ean', ean)
    .order('created_at', { ascending: true })
    .limit(1);
  if (error) throw error;
  const row = data?.[0];
  return row ? { id: row.id as string, name: row.name as string } : null;
}

/**
 * Bind a mapping to a catalog EAN, merging into the canonical master and
 * enriching general columns from the catalog taxonomy.
 */
export async function bindMappingToEan(
  supermarketProductId: string,
  ean: string,
): Promise<BindEanResult> {
  // 1. Load the mapping + its current master.
  const mappingRes = await db
    .from('supermarket_products')
    .select('id, product_id')
    .eq('id', supermarketProductId)
    .maybeSingle();
  if (mappingRes.error) throw mappingRes.error;
  if (!mappingRes.data) {
    throw new Error(`supermarket_product "${supermarketProductId}" not found`);
  }
  const oldProductId = mappingRes.data.product_id as string;

  const tax = await lookupCatalog(ean);

  // 2. Find or create the canonical master for this EAN.
  const existing = await findMasterByEan(ean);
  let canonicalId: string;
  let createdMaster = false;

  if (existing) {
    canonicalId = existing.id;
    // Backfill/refresh taxonomy on the canonical row when the EAN is in the
    // catalog (the client's values are authoritative for these columns).
    if (tax) {
      const { error } = await db.from('products').update(taxonomyPatch(tax)).eq('id', canonicalId);
      if (error) throw error;
    }
  } else {
    // No master carries this EAN yet — promote the current master in place by
    // stamping the EAN + taxonomy onto it (keeps its scraped name/unit/metadata).
    const { error } = await db
      .from('products')
      .update({ ean, ...(tax ? taxonomyPatch(tax) : {}) })
      .eq('id', oldProductId);
    if (error) throw error;
    logger.info({ smpId: supermarketProductId, ean, productId: oldProductId }, 'stamped EAN onto master in place');
    return {
      supermarketProductId,
      ean,
      productId: oldProductId,
      merged: false,
      removedOrphanMaster: false,
      createdMaster: false,
    };
  }

  // 3. Already pointing at the canonical master — nothing to move.
  if (oldProductId === canonicalId) {
    return {
      supermarketProductId,
      ean,
      productId: canonicalId,
      merged: false,
      removedOrphanMaster: false,
      createdMaster,
    };
  }

  // 4. Re-point the mapping to the canonical master. Snapshots follow the
  //    mapping, so price history is preserved automatically.
  const repoint = await db
    .from('supermarket_products')
    .update({ product_id: canonicalId })
    .eq('id', supermarketProductId);
  if (repoint.error) throw repoint.error;

  // 5. Drop the old master if nothing references it anymore.
  let removedOrphanMaster = false;
  const remaining = await db
    .from('supermarket_products')
    .select('id', { count: 'exact', head: true })
    .eq('product_id', oldProductId);
  if (remaining.error) throw remaining.error;
  if ((remaining.count ?? 0) === 0) {
    const del = await db.from('products').delete().eq('id', oldProductId);
    if (del.error) throw del.error;
    removedOrphanMaster = true;
  }

  logger.info(
    { smpId: supermarketProductId, ean, from: oldProductId, to: canonicalId, removedOrphanMaster },
    'mapping bound to canonical EAN master',
  );

  return {
    supermarketProductId,
    ean,
    productId: canonicalId,
    merged: true,
    removedOrphanMaster,
    createdMaster,
  };
}
