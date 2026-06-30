/**
 * Load the master catalog straight from the DB (the products table) for
 * matching. The original PoC fetched our own REST API; here we have direct DB
 * access, so we skip the round-trip and the API key.
 */

import { db, fetchAllPages } from '../shared/db.js';

export interface CatalogProduct {
  id: string;
  name: string;
  brand?: string;
  ean?: string;
  quantity?: string;
}

interface ProductRow {
  id: string;
  name: string | null;
  brand: string | null;
  ean: string | null;
  unit: string | null;
  format: string | null;
}

/** Every master product, normalized for the matcher. */
export async function loadCatalog(): Promise<CatalogProduct[]> {
  const rows = await fetchAllPages<ProductRow>((from, to) =>
    db
      .from('products')
      .select('id, name, brand, ean, unit, format')
      .order('id', { ascending: true })
      .range(from, to),
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name ?? '',
    brand: r.brand ?? undefined,
    ean: r.ean ?? undefined,
    quantity: r.unit ?? r.format ?? undefined,
  }));
}
