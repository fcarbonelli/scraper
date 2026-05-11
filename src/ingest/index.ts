/**
 * Shared ingest logic — turn a product URL into rows in the database.
 *
 * Used by:
 *   - scripts/scrape-url.ts   (one URL on the command line)
 *   - scripts/import-urls.ts  (bulk file)
 *   - src/api/routes/products (POST endpoints used by the frontend)
 *
 * Per-URL flow:
 *   1. Detect which supermarket adapter handles this hostname
 *   2. Canonicalize the URL (adapter-specific)
 *   3. Resolve the external_id (adapter-specific; may involve an API call)
 *   4. Look up the supermarket_products row, or create it (along with a
 *      master products row, deduped by EAN when possible)
 *   5. Optionally run processJob to capture a first price snapshot
 */

import { db } from '../shared/db.js';
import { logger } from '../shared/logger.js';
import { getAdapter } from '../adapters/registry.js';
import type { ScrapeContext } from '../adapters/types.js';
import { processJob, type ProcessJobResult } from '../worker/processJob.js';

export interface SupermarketConfig {
  id: string;
  name: string;
  baseUrl: string | null;
  rateLimitMs: number;
  concurrency: number;
  config: Record<string, unknown>;
}

export interface EnsureResult {
  supermarketProductId: string;
  externalId: string;
  externalUrl: string;
  /** True if the supermarket_products row already existed before this call. */
  alreadyExisted: boolean;
}

export interface IngestOptions {
  /**
   * If true (default), skip the initial price scrape for URLs that were
   * already imported. Set false to force a fresh snapshot every time
   * (single-URL CLI behavior).
   */
  skipScrapeIfExists?: boolean;
  /**
   * If false, never run the initial price scrape — just probe + seed rows.
   * Default: true. The API uses `false` so adding products from the UI is
   * fast and just registers them for the next scheduled run.
   */
  runInitialScrape?: boolean;
}

export interface IngestResult {
  url: string;
  canonicalUrl: string;
  supermarketId: string;
  supermarketProductId: string;
  externalId: string;
  alreadyExisted: boolean;
  /** Result of the initial scrape, or null if no scrape was run. */
  scrape: ProcessJobResult | null;
}

/**
 * Detect which supermarket adapter handles this URL by hostname.
 *
 * Order matters: more-specific hosts must be checked before generic ones
 * (e.g. `comerciante.carrefour.com.ar` → maxi-carrefour, not regular carrefour).
 */
export function detectSupermarket(url: string): string {
  const host = new URL(url).host.toLowerCase();
  if (host.includes('cotodigital')) return 'coto';
  if (host.includes('comerciante.carrefour')) return 'maxi-carrefour';
  if (host.includes('carrefour.com.ar')) return 'carrefour';
  if (host.includes('maxiconsumo')) return 'maxiconsumo';
  if (host.includes('atomoconviene')) return 'atomo';
  if (host.includes('lacoopeencasa')) return 'lacoopeencasa';
  throw new Error(`No supermarket adapter known for host "${host}"`);
}

/**
 * Ask the adapter how to derive its external_id from a canonical URL.
 * Falls back to the URL pathname if the adapter doesn't implement it.
 */
export async function resolveExternalIdForUrl(
  supermarketId: string,
  canonicalUrl: string,
): Promise<string> {
  const adapter = getAdapter(supermarketId);
  if (adapter.resolveExternalId) {
    return adapter.resolveExternalId(canonicalUrl);
  }
  return new URL(canonicalUrl).pathname;
}

/** Load a supermarket's config row from the DB. Throws if missing or inactive. */
export async function loadSupermarketConfig(
  supermarketId: string,
): Promise<SupermarketConfig> {
  const { data, error } = await db
    .from('supermarkets')
    .select('id, name, base_url, rate_limit_ms, concurrency, config, is_active')
    .eq('id', supermarketId)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new Error(
      `Supermarket "${supermarketId}" not in DB. Run 'npm run db:setup' first.`,
    );
  }
  if (!data.is_active) {
    throw new Error(`Supermarket "${supermarketId}" is inactive.`);
  }
  return {
    id: data.id,
    name: data.name,
    baseUrl: data.base_url,
    rateLimitMs: data.rate_limit_ms,
    concurrency: data.concurrency,
    config: (data.config as Record<string, unknown>) ?? {},
  };
}

/**
 * Find (or create) the supermarket_products row and matching master products
 * row for the given URL. Idempotent — re-running with the same URL returns
 * the existing row with `alreadyExisted: true`.
 */
export async function ensureSupermarketProduct(
  supermarketId: string,
  externalUrl: string,
): Promise<EnsureResult> {
  const adapter = getAdapter(supermarketId);
  const canonical = adapter.canonicalizeUrl
    ? adapter.canonicalizeUrl(externalUrl)
    : externalUrl;

  // Adapter decides how its external_id is derived (URL parsing for Coto,
  // pagetype API call for Carrefour, etc.). Done once per URL.
  const externalId = await resolveExternalIdForUrl(supermarketId, canonical);

  const existing = await db
    .from('supermarket_products')
    .select('id')
    .eq('supermarket_id', supermarketId)
    .eq('external_id', externalId)
    .maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data) {
    logger.debug({ smpId: existing.data.id, externalId }, 'using existing supermarket_product');
    return {
      supermarketProductId: existing.data.id as string,
      externalId,
      externalUrl: canonical,
      alreadyExisted: true,
    };
  }

  // First time: probe the adapter to extract product info for seeding.
  const supermarketConfig = await loadSupermarketConfig(supermarketId);
  const ctx: ScrapeContext = {
    supermarketProductId: 'pending',
    externalId,
    externalUrl: canonical,
    config: supermarketConfig,
    logger: logger.child({ supermarket: supermarketId, externalId }),
  };
  logger.debug({ url: canonical, externalId }, 'adapter probe to extract product info');
  const probe = await adapter.scrape(ctx);
  const info = probe.productInfo ?? {};

  // Reuse master product by EAN if known; otherwise insert a new master row.
  let productId: string | undefined;
  if (info.ean) {
    const { data, error } = await db
      .from('products')
      .select('id')
      .eq('ean', info.ean)
      .maybeSingle();
    if (error) throw error;
    if (data) productId = data.id as string;
  }

  if (!productId) {
    const insert = await db
      .from('products')
      .insert({
        name: info.name ?? 'Unknown product',
        category: info.category ?? null,
        brand: info.brand ?? null,
        unit: info.unit ?? null,
        ean: info.ean ?? null,
        metadata: {
          ...(info.imageUrl ? { imageUrl: info.imageUrl } : {}),
          ...(info.metadata ?? {}),
        },
      })
      .select('id')
      .single();
    if (insert.error) throw insert.error;
    productId = insert.data.id as string;
    logger.debug({ productId, name: info.name, ean: info.ean }, 'created master product');
  }

  const smpInsert = await db
    .from('supermarket_products')
    .insert({
      supermarket_id: supermarketId,
      product_id: productId,
      external_id: externalId,
      external_url: canonical,
      is_active: true,
    })
    .select('id')
    .single();
  if (smpInsert.error) throw smpInsert.error;

  return {
    supermarketProductId: smpInsert.data.id as string,
    externalId,
    externalUrl: canonical,
    alreadyExisted: false,
  };
}

/**
 * Full ingest flow for one URL: detect → ensure rows exist → optionally
 * create a first price snapshot.
 *
 * For URLs already in the DB, the scrape runs only when
 * `opts.skipScrapeIfExists` is false. Default is true, so bulk imports
 * don't pay for unnecessary repeated scrapes.
 *
 * Set `opts.runInitialScrape: false` to skip the first scrape entirely
 * (used by the API — newly-added products are picked up by the next
 * scheduled run instead).
 */
export async function ingestUrl(
  url: string,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const supermarketId = detectSupermarket(url);
  const ensured = await ensureSupermarketProduct(supermarketId, url);

  const skipScrape = opts.skipScrapeIfExists ?? true;
  const runInitialScrape = opts.runInitialScrape ?? true;
  const shouldScrape =
    runInitialScrape && (!ensured.alreadyExisted || !skipScrape);

  let scrape: ProcessJobResult | null = null;
  if (shouldScrape) {
    scrape = await processJob(
      {
        supermarketProductId: ensured.supermarketProductId,
        supermarketId,
        externalId: ensured.externalId,
        externalUrl: ensured.externalUrl,
        scrapeRunId: null,
      },
      { attempt: 1 },
    );
  }

  return {
    url,
    canonicalUrl: ensured.externalUrl,
    supermarketId,
    supermarketProductId: ensured.supermarketProductId,
    externalId: ensured.externalId,
    alreadyExisted: ensured.alreadyExisted,
    scrape,
  };
}
