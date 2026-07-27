/**
 * Load the official Catálogo EAN for revista matching.
 *
 * Matching against master `products` pulled in wrong EANs and scraped junk.
 * The client taxonomy (built-in ∪ catalog_extra_eans) is the source of truth:
 * clean descriptionForms / brand / format, and the EAN that must reach export.
 */

import { getCatalogEans } from '../shared/catalog.js';

export interface CatalogProduct {
  /** Matcher id = EAN (judge + candidates key off this string). */
  id: string;
  name: string;
  brand?: string;
  ean?: string;
  quantity?: string;
}

/** Every Catálogo EAN entry, normalized for the matcher. */
export async function loadCatalog(): Promise<CatalogProduct[]> {
  const map = await getCatalogEans();
  const out: CatalogProduct[] = [];
  for (const [ean, tax] of map) {
    const quantity = [tax.format, tax.variety].filter(Boolean).join(' ').trim() || undefined;
    out.push({
      id: ean,
      name: tax.descriptionForms || ean,
      brand: tax.brand || undefined,
      ean,
      quantity,
    });
  }
  // Stable order helps embedding batching / debug diffs.
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
