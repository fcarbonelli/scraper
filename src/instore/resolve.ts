/**
 * Resolve a scanned EAN to a master `products` row for in-store price entry.
 *
 * "Our product list" the operator checks against is the client catalog: the
 * hardcoded taxonomy ∪ catalog_extra_eans (see src/shared/catalog.ts).
 *
 * OFF-LIST GUARD: in-store entry is allowed ONLY for EANs on the official
 * catalog. Membership on the catalog — NOT the mere existence of a `products`
 * row — is what qualifies an EAN. Otherwise a leftover scraped/imported row for
 * a store's own barcode (an off-list EAN, e.g. the same item under a second
 * barcode) would silently become reusable here and leak into the client base.
 *
 * So a scanned EAN resolves as:
 *
 *   1. On the catalog AND a master `products` row already exists (it was also
 *      scraped online, e.g. Coto) → reuse that row.
 *   2. On the catalog, no product row yet → create a master row seeded from the
 *      catalog taxonomy. Wholesale-only chains carry many items never scraped
 *      online, so this is the common path.
 *   3. NOT on the catalog (whether or not a stray `products` row exists) →
 *      "not in catalog"; the UI lets the operator skip it.
 *
 * The lookup (GET /v1/in-store/lookup) is READ-ONLY — it never creates a row.
 * Creation only happens when a price is actually submitted (see entry.ts).
 */

import { db } from '../shared/db.js';
import { logger } from '../shared/logger.js';
import { lookupCatalog } from '../shared/catalog.js';
import { MARCA_TO_FABRICANTE, type TaxonomyEntry } from '../shared/taxonomy.js';

/** Where a matched product came from. */
export type MatchSource = 'products' | 'catalog';

/** A resolved catalog product, ready to show the operator before they type a price. */
export interface ResolvedProduct {
  productId: string | null; // null when it only exists in the catalog (not yet created)
  ean: string;
  name: string;
  brand: string | null;
  manufacturer: string | null;
  category: string | null;
  subcategory: string | null;
  format: string | null;
  variety: string | null;
  /** Product photo (from products.metadata.imageUrl). null for catalog-only matches. */
  imageUrl: string | null;
  source: MatchSource;
}

interface ProductRow {
  id: string;
  name: string;
  brand: string | null;
  manufacturer: string | null;
  category: string | null;
  subcategory: string | null;
  format: string | null;
  variety: string | null;
  metadata: { imageUrl?: string | null } | null;
}

const PRODUCT_COLS =
  'id, name, brand, manufacturer, category, subcategory, format, variety, metadata';

/** Find an existing master product by EAN. */
async function findProductByEan(ean: string): Promise<ProductRow | null> {
  const { data, error } = await db
    .from('products')
    .select(PRODUCT_COLS)
    .eq('ean', ean)
    .maybeSingle();
  if (error) throw error;
  return (data as ProductRow | null) ?? null;
}

function taxonomyToResolved(ean: string, t: TaxonomyEntry): ResolvedProduct {
  return {
    productId: null,
    ean,
    name: t.descriptionForms || 'Producto de catálogo',
    brand: t.brand || null,
    manufacturer: t.manufacturer || null,
    category: t.category || null,
    subcategory: t.subcategory || null,
    format: t.format || null,
    variety: t.variety || null,
    // Catalog-only matches have no product row yet, so no image — the UI shows
    // a placeholder.
    imageUrl: null,
    source: 'catalog',
  };
}

/**
 * Read-only resolve for the lookup endpoint. Returns the product for a scanned
 * EAN (from products, else from the catalog), or null when it's in neither.
 */
export async function resolveEan(ean: string): Promise<ResolvedProduct | null> {
  // Off-list guard: an EAN qualifies for in-store entry only if it's on the
  // official catalog. A stray scraped `products` row for an off-list barcode
  // must NOT be reusable here (see module header).
  const catalog = await lookupCatalog(ean);
  if (!catalog) return null;

  const existing = await findProductByEan(ean);
  if (existing) {
    return {
      productId: existing.id,
      ean,
      name: existing.name,
      brand: existing.brand,
      manufacturer: existing.manufacturer,
      category: existing.category,
      subcategory: existing.subcategory,
      format: existing.format,
      variety: existing.variety,
      imageUrl: existing.metadata?.imageUrl ?? null,
      source: 'products',
    };
  }

  return taxonomyToResolved(ean, catalog);
}

/**
 * Resolve an EAN to a concrete master product id, CREATING one from catalog
 * taxonomy when needed. Used when actually recording a price. Returns null only
 * when the EAN is in neither products nor the catalog (caller rejects it).
 */
export async function ensureMasterProductForEan(
  ean: string,
): Promise<string | null> {
  // Off-list guard (mirrors resolveEan): never materialize a price for an EAN
  // that isn't on the official catalog, even if a stray scraped row exists.
  const catalog = await lookupCatalog(ean);
  if (!catalog) return null;

  const existing = await findProductByEan(ean);
  if (existing) return existing.id;

  // Seed a master row from the catalog reference so the export gets full
  // taxonomy columns immediately (same fields the ingest path fills).
  const insert = await db
    .from('products')
    .insert({
      name: catalog.descriptionForms || 'Producto de catálogo',
      category: catalog.category || null,
      subcategory: catalog.subcategory || null,
      manufacturer:
        catalog.manufacturer ||
        MARCA_TO_FABRICANTE[(catalog.brand ?? '').trim().toUpperCase()] ||
        null,
      brand: catalog.brand || null,
      format: catalog.format || null,
      variety: catalog.variety || null,
      description_forms: catalog.descriptionForms || null,
      ean,
      metadata: { source: 'instore' },
    })
    .select('id')
    .single();
  if (insert.error) throw insert.error;

  logger.debug({ ean, productId: insert.data.id }, 'instore: created master product from catalog');
  return insert.data.id as string;
}
