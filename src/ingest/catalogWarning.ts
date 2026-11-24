/**
 * Non-blocking "this product won't have client labels" check for manual adds.
 *
 * The export's general columns (Categoria, Marca, Descripcion para forms, …)
 * come from the client catalog keyed by EAN. A URL whose page reports an EAN
 * outside the catalog — often an alternate/old barcode of a catalog product —
 * or no EAN at all ingests fine but exports with blank labels (or not at all).
 * Operators adding URLs by hand get a warning plus catalog EAN suggestions so
 * they can re-add with `ean` or bind via PATCH /v1/supermarket-products/:id.
 *
 * Side-effecting: reads the DB.
 */

import { db } from '../shared/db.js';
import { getCatalogEans } from '../shared/catalog.js';
import { logger } from '../shared/logger.js';
import { buildEanIndex, suggestEansFromIndex, type EanSuggestion } from '../discovery/eanMatch.js';

export interface CatalogWarning {
  code: 'ean_not_in_catalog' | 'missing_ean';
  /** EAN currently on the master product (null when the page exposed none). */
  ean: string | null;
  message: string;
  /** Up to 3 catalog EANs that look like the same product, best first. */
  suggestions: EanSuggestion[];
}

/**
 * Return a warning when the mapping's master product has no catalog EAN, or
 * null when it's fine. Never throws: a failed check must not fail the ingest.
 */
export async function catalogWarningFor(
  supermarketProductId: string,
  url: string,
): Promise<CatalogWarning | null> {
  try {
    const { data, error } = await db
      .from('supermarket_products')
      .select('products(ean, name, brand)')
      .eq('id', supermarketProductId)
      .maybeSingle();
    if (error) throw error;
    const product = data?.products as unknown as
      | { ean: string | null; name: string | null; brand: string | null }
      | null
      | undefined;
    if (!product) return null;

    const catalog = await getCatalogEans();
    const ean = product.ean?.trim() || null;
    if (ean && catalog.has(ean)) return null;

    const index = await buildEanIndex();
    const suggestions = suggestEansFromIndex(
      index,
      { name: product.name ?? '', brand: product.brand, url },
      3,
      (candidate) => catalog.has(candidate),
    );
    return ean
      ? {
          code: 'ean_not_in_catalog',
          ean,
          message: `EAN ${ean} is not in the client catalog; the product will export with blank labels until it is bound to a catalog EAN.`,
          suggestions,
        }
      : {
          code: 'missing_ean',
          ean: null,
          message: 'The page exposes no EAN; the product is left out of the export until it is bound to a catalog EAN.',
          suggestions,
        };
  } catch (err) {
    logger.warn({ err, supermarketProductId }, 'catalog warning check failed');
    return null;
  }
}
