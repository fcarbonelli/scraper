/**
 * Catalog overview — the product-centric "what we ACTUALLY scrape/export" view.
 *
 * Powers `GET /v1/data/catalog`. Unlike `GET /v1/products` (which lists every
 * master `products` row, including EAN-less, never-scraped and fully-paused
 * junk), this module computes the **exportable set**: distinct master products
 * that have at least one ACTIVE mapping on an ACTIVE chain — i.e. exactly the
 * products the daily `client_base` export will emit.
 *
 * The definition mirrors the `client_base` view's active gate (migration 008:
 * `supermarkets.is_active = true AND supermarket_products.is_active = true`), so
 * the headline count here lines up with what the client receives.
 *
 * We aggregate in JS (small scale: a few hundred products across ~30 chains)
 * following the same pattern as the coverage endpoint, but page every table
 * read past Supabase's 1000-row response cap so the numbers stay correct as the
 * mapping count grows.
 */

import { db } from '../../shared/db.js';
import { getCatalogEans } from '../../shared/catalog.js';

/** One chain that carries a product, with its per-mapping status. */
export interface CatalogChain {
  id: string;
  name: string;
  cadenaDisplayName: string | null;
  canal: string | null;
  /** 'active' = scraped daily; 'paused' = mapping is_active=false (kept for review). */
  status: 'active' | 'paused';
  url: string | null;
}

/** A single exportable product with coverage + latest-export context. */
export interface CatalogProduct {
  productId: string;
  ean: string | null;
  name: string;
  descriptionForms: string | null;
  category: string | null;
  subcategory: string | null;
  brand: string | null;
  manufacturer: string | null;
  format: string | null;
  variety: string | null;
  unit: string | null;
  imageUrl: string | null;
  /** Active mappings on active chains (what gets scraped). */
  chainsActive: number;
  /** Paused mappings on active chains (kept, not scraped). */
  chainsPaused: number;
  /** chainsActive + chainsPaused (mappings on active chains only). */
  chainsTotal: number;
  /** Per-chain breakdown (active chains only), sorted by chain name. */
  chains: CatalogChain[];
  /** True if this product's EAN appears in the most recent daily export. */
  inLatestExport: boolean;
  /** Number of chains that emitted a row for this product in the latest export. */
  latestExportChains: number;
  /** Lowest "Precio_MasBajo" across chains in the latest export (null if none). */
  priceMin: number | null;
  /** Highest "Precio_MasBajo" across chains in the latest export (null if none). */
  priceMax: number | null;
}

/** Per-supermarket rollup of the exportable universe (for a coverage panel). */
export interface CatalogSupermarketRollup {
  id: string;
  name: string;
  canal: string | null;
  cadenaDisplayName: string | null;
  isActive: boolean;
  /** Exportable products this chain scrapes (active mappings). */
  active: number;
  /** Exportable products paused at this chain. */
  paused: number;
  /** active + paused. */
  total: number;
}

/** Headline KPIs describing the whole exportable universe (unfiltered). */
export interface CatalogSummary {
  /** Distinct exportable products — the number the client view should match. */
  totalProducts: number;
  /** Active mappings on active chains across the exportable set. */
  totalActiveMappings: number;
  /** Paused mappings on active chains across the exportable set. */
  totalPausedMappings: number;
  /** Count of active supermarkets. */
  activeChains: number;
  /** Count of supermarkets (active + inactive). */
  totalChains: number;
  /** Size of the reference catalog (hardcoded ∪ runtime extra EANs). */
  catalogEans: number;
  /** Most recent Fecha_Relevamiento present in client_base (null if empty). */
  lastExportDate: string | null;
  /** Rows in client_base on lastExportDate. */
  rowsInLastExport: number;
  /** Distinct products (by EAN) in client_base on lastExportDate. */
  productsInLastExport: number;
  /** Per-supermarket coverage of the exportable set. */
  bySupermarket: CatalogSupermarketRollup[];
}

export interface CatalogOverview {
  summary: CatalogSummary;
  /** Full exportable set (unfiltered, unpaginated); the route filters/paginates. */
  products: CatalogProduct[];
}

interface SupermarketRow {
  id: string;
  name: string;
  canal: string | null;
  cadena_display_name: string | null;
  is_active: boolean;
}

interface MappingRow {
  product_id: string;
  supermarket_id: string;
  is_active: boolean;
  external_url: string | null;
}

interface ProductRow {
  id: string;
  name: string;
  category: string | null;
  subcategory: string | null;
  brand: string | null;
  manufacturer: string | null;
  format: string | null;
  variety: string | null;
  description_forms: string | null;
  unit: string | null;
  ean: string | null;
  metadata: Record<string, unknown> | null;
}

/**
 * Read every row of a table past Supabase's default 1000-row cap, paging in
 * 1000-row batches. An optional equality filter narrows the read at the DB.
 */
async function fetchAll<T>(
  table: string,
  columns: string,
  eqFilter?: { column: string; value: string },
): Promise<T[]> {
  const pageSize = 1000;
  const all: T[] = [];
  let offset = 0;
  for (;;) {
    let query = db.from(table).select(columns);
    if (eqFilter) query = query.eq(eqFilter.column, eqFilter.value);
    const { data, error } = await query.range(offset, offset + pageSize - 1);
    if (error) throw error;
    const rows = (data ?? []) as T[];
    all.push(...rows);
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

/** Extract the imageUrl from a product's metadata jsonb, if present. */
function imageUrlOf(metadata: Record<string, unknown> | null): string | null {
  const v = metadata?.['imageUrl'];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Build the full catalog overview: the exportable set + summary KPIs.
 * The route layer handles filtering, sorting and pagination on top of this.
 */
export async function buildCatalogOverview(): Promise<CatalogOverview> {
  // 1. Supermarkets — split active vs inactive; only active chains count.
  const supermarkets = await fetchAll<SupermarketRow>(
    'supermarkets',
    'id, name, canal, cadena_display_name, is_active',
  );
  const smById = new Map(supermarkets.map((s) => [s.id, s]));
  const activeChainIds = new Set(
    supermarkets.filter((s) => s.is_active).map((s) => s.id),
  );

  // 2. All mappings. Aggregate per product, ignoring mappings on inactive
  //    chains (those never reach the client export).
  const mappings = await fetchAll<MappingRow>(
    'supermarket_products',
    'product_id, supermarket_id, is_active, external_url',
  );

  interface Agg {
    active: number;
    paused: number;
    chains: CatalogChain[];
  }
  const perProduct = new Map<string, Agg>();
  // Per-supermarket rollup counters (exportable universe).
  const smRollup = new Map<string, { active: number; paused: number }>();

  for (const m of mappings) {
    if (!activeChainIds.has(m.supermarket_id)) continue;
    const sm = smById.get(m.supermarket_id);
    if (!sm) continue;

    let agg = perProduct.get(m.product_id);
    if (!agg) {
      agg = { active: 0, paused: 0, chains: [] };
      perProduct.set(m.product_id, agg);
    }
    agg.chains.push({
      id: sm.id,
      name: sm.name,
      cadenaDisplayName: sm.cadena_display_name,
      canal: sm.canal,
      status: m.is_active ? 'active' : 'paused',
      url: m.external_url,
    });
    if (m.is_active) agg.active++;
    else agg.paused++;
  }

  // Exportable = at least one ACTIVE mapping on an active chain.
  const exportableIds = new Set(
    [...perProduct].filter(([, a]) => a.active > 0).map(([id]) => id),
  );

  // Roll up per-supermarket counts across the exportable set only.
  for (const [productId, agg] of perProduct) {
    if (!exportableIds.has(productId)) continue;
    for (const c of agg.chains) {
      let r = smRollup.get(c.id);
      if (!r) {
        r = { active: 0, paused: 0 };
        smRollup.set(c.id, r);
      }
      if (c.status === 'active') r.active++;
      else r.paused++;
    }
  }

  // 3. Product taxonomy for the exportable set. Fetch all products then keep
  //    the exportable ones (avoids a giant `in()` URL with hundreds of UUIDs).
  const productRows = await fetchAll<ProductRow>(
    'products',
    'id, name, category, subcategory, brand, manufacturer, format, variety, description_forms, unit, ean, metadata',
  );

  // 4. Latest daily export snapshot: presence + price range per EAN.
  const { lastExportDate, byEan, rowsInLastExport, productsInLastExport } =
    await loadLatestExport();

  // 5. Assemble product objects.
  const products: CatalogProduct[] = [];
  for (const p of productRows) {
    const agg = perProduct.get(p.id);
    if (!agg || !exportableIds.has(p.id)) continue;

    const chains = [...agg.chains].sort((a, b) => a.name.localeCompare(b.name));
    const exp = p.ean ? byEan.get(p.ean) : undefined;

    products.push({
      productId: p.id,
      ean: p.ean,
      name: p.name,
      descriptionForms: p.description_forms,
      category: p.category,
      subcategory: p.subcategory,
      brand: p.brand,
      manufacturer: p.manufacturer,
      format: p.format,
      variety: p.variety,
      unit: p.unit,
      imageUrl: imageUrlOf(p.metadata),
      chainsActive: agg.active,
      chainsPaused: agg.paused,
      chainsTotal: agg.active + agg.paused,
      chains,
      inLatestExport: Boolean(exp),
      latestExportChains: exp?.chains ?? 0,
      priceMin: exp?.min ?? null,
      priceMax: exp?.max ?? null,
    });
  }

  const totalActiveMappings = products.reduce((n, p) => n + p.chainsActive, 0);
  const totalPausedMappings = products.reduce((n, p) => n + p.chainsPaused, 0);
  const catalog = await getCatalogEans();

  const bySupermarket: CatalogSupermarketRollup[] = supermarkets
    .filter((s) => s.is_active)
    .map((s) => {
      const r = smRollup.get(s.id) ?? { active: 0, paused: 0 };
      return {
        id: s.id,
        name: s.name,
        canal: s.canal,
        cadenaDisplayName: s.cadena_display_name,
        isActive: s.is_active,
        active: r.active,
        paused: r.paused,
        total: r.active + r.paused,
      };
    })
    .sort((a, b) => b.active - a.active || a.name.localeCompare(b.name));

  const summary: CatalogSummary = {
    totalProducts: products.length,
    totalActiveMappings,
    totalPausedMappings,
    activeChains: activeChainIds.size,
    totalChains: supermarkets.length,
    catalogEans: catalog.size,
    lastExportDate,
    rowsInLastExport,
    productsInLastExport,
    bySupermarket,
  };

  return { summary, products };
}

interface LatestExportEan {
  chains: number;
  min: number | null;
  max: number | null;
}

/**
 * Load the most recent daily export from `client_base` and reduce it to a
 * per-EAN summary (how many chains emitted a row + the price range that day).
 * Returns empty structures when the export is empty.
 */
async function loadLatestExport(): Promise<{
  lastExportDate: string | null;
  byEan: Map<string, LatestExportEan>;
  rowsInLastExport: number;
  productsInLastExport: number;
}> {
  const byEan = new Map<string, LatestExportEan>();

  const { data: latest, error: latestErr } = await db
    .from('client_base')
    .select('Fecha_Relevamiento')
    .order('Fecha_Relevamiento', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestErr) throw latestErr;

  const lastExportDate =
    latest && typeof latest.Fecha_Relevamiento === 'string'
      ? latest.Fecha_Relevamiento
      : null;
  if (!lastExportDate) {
    return { lastExportDate: null, byEan, rowsInLastExport: 0, productsInLastExport: 0 };
  }

  const rows = await fetchAll<{ EAN: string | null; Precio_MasBajo: number | null }>(
    'client_base',
    'EAN, Precio_MasBajo',
    { column: 'Fecha_Relevamiento', value: lastExportDate },
  );

  let rowsInLastExport = 0;
  for (const row of rows) {
    rowsInLastExport++;
    const ean = row.EAN;
    if (!ean) continue;
    let e = byEan.get(ean);
    if (!e) {
      e = { chains: 0, min: null, max: null };
      byEan.set(ean, e);
    }
    e.chains++;
    const price = typeof row.Precio_MasBajo === 'number' ? row.Precio_MasBajo : null;
    if (price !== null) {
      e.min = e.min === null ? price : Math.min(e.min, price);
      e.max = e.max === null ? price : Math.max(e.max, price);
    }
  }

  return {
    lastExportDate,
    byEan,
    rowsInLastExport,
    productsInLastExport: byEan.size,
  };
}
