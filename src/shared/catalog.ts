/**
 * Catalog loader — the UNION of the hardcoded client catalog and the
 * runtime-added extra EANs table.
 *
 * `src/shared/taxonomy.ts` stays a pure, side-effect-free module holding the
 * original 211 official products. This module layers the DB-backed
 * `catalog_extra_eans` table on top so operators can add new EANs at runtime
 * (see docs/PRODUCT_MANAGEMENT.md). Coverage and discovery read from here.
 *
 * Side-effecting: touches the DB. A short in-memory TTL cache keeps the
 * per-request coverage query from re-fetching the (small) extra-EANs table.
 */

import { db } from './db.js';
import { logger } from './logger.js';
import { TAXONOMY_BY_EAN, type TaxonomyEntry } from './taxonomy.js';

/** How long the merged catalog is cached in-process before a DB refresh. */
const CACHE_TTL_MS = 60_000;

let cache: { map: Map<string, TaxonomyEntry>; loadedAt: number } | null = null;

/** Row shape of the catalog_extra_eans table. */
interface ExtraEanRow {
  ean: string;
  description_forms: string;
  category: string | null;
  subcategory: string | null;
  brand: string | null;
  manufacturer: string | null;
  format: string | null;
  variety: string | null;
}

function rowToEntry(row: ExtraEanRow): TaxonomyEntry {
  return {
    ean: row.ean,
    descriptionForms: row.description_forms,
    category: row.category ?? '',
    subcategory: row.subcategory ?? '',
    brand: row.brand ?? '',
    manufacturer: row.manufacturer ?? '',
    format: row.format ?? '',
    variety: row.variety ?? '',
  };
}

/**
 * Return the merged catalog (hardcoded ∪ extra EANs), keyed by EAN.
 * Cached for CACHE_TTL_MS. A DB error falls back to just the hardcoded map
 * so coverage never hard-fails on a read blip.
 */
export async function getCatalogEans(): Promise<Map<string, TaxonomyEntry>> {
  const now = Date.now();
  if (cache && now - cache.loadedAt < CACHE_TTL_MS) return cache.map;

  const merged = new Map<string, TaxonomyEntry>(TAXONOMY_BY_EAN);

  const { data, error } = await db
    .from('catalog_extra_eans')
    .select('ean, description_forms, category, subcategory, brand, manufacturer, format, variety');

  if (error) {
    logger.warn({ err: error }, 'failed to load catalog_extra_eans; using hardcoded catalog only');
    // Cache the fallback briefly too, to avoid hammering a struggling DB.
    cache = { map: merged, loadedAt: now };
    return merged;
  }

  for (const row of (data ?? []) as ExtraEanRow[]) {
    // Hardcoded entries win over extras with the same EAN (extras can't
    // shadow the official reference).
    if (!merged.has(row.ean)) merged.set(row.ean, rowToEntry(row));
  }

  cache = { map: merged, loadedAt: now };
  return merged;
}

/** Look up one EAN in the merged catalog. */
export async function lookupCatalog(ean: string): Promise<TaxonomyEntry | undefined> {
  const map = await getCatalogEans();
  return map.get(ean);
}

/** True if this EAN is part of the immutable hardcoded catalog. */
export function isBuiltInEan(ean: string): boolean {
  return TAXONOMY_BY_EAN.has(ean);
}

/** Drop the cache so the next read reflects a just-written change. */
export function invalidateCatalogCache(): void {
  cache = null;
}
