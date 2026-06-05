/**
 * Carrefour Argentina adapter (VTEX-based).
 *
 * Carrefour runs on the VTEX commerce platform and exposes the standard VTEX
 * Catalog API publicly:
 *
 *   GET /api/catalog_system/pub/products/search?fq=productId:<id>
 *
 * The user-facing URL is a slug (e.g. /lavandina-ayudin-original-1-l/p) and
 * does NOT contain the productId, so first-time ingestion needs an extra
 * lookup against VTEX's "pagetype" endpoint:
 *
 *   GET /api/catalog_system/pub/portal/pagetype/<slug>/p
 *     -> { id, pageType: "Product", name, ... }
 *
 * That id is stored in supermarket_products.external_id, so daily scrapes
 * only ever do one HTTP call (the catalog lookup).
 *
 * Most other LATAM supermarkets (Disco, Jumbo, Vea, Día) also run VTEX, so
 * this adapter is a useful template — usually only the host changes.
 */

import { ScrapeError } from '../shared/errors.js';
import type {
  ProductInfo,
  Promotion,
  ScrapeContext,
  ScrapeResult,
  SupermarketAdapter,
} from './types.js';
import { vtexSearchByEan } from './vtex-search.js';
import { runWithGeoFallback } from './geo-retry.js';
import { resolveRegionId, withRegion } from './vtex-region.js';
import type { Zone } from './zones.js';

// =============================================================================
// Constants
// =============================================================================

const REQUEST_TIMEOUT_MS = 15_000;
const CARREFOUR_HOST = 'www.carrefour.com.ar';
const CARREFOUR_BASE = `https://${CARREFOUR_HOST}`;

const USER_AGENT =
  'Mozilla/5.0 (compatible; PriceScraperBot/1.0; +https://example.com/bot)';

// =============================================================================
// VTEX response shapes
// Only the fields we read are typed strictly; the rest stay `unknown`.
// =============================================================================

interface PageTypeResponse {
  id: string | null;
  pageType: string;
  name?: string;
  url?: string;
}

interface VtexCommertialOffer {
  Price?: number;
  ListPrice?: number;
  PriceWithoutDiscount?: number;
  IsAvailable?: boolean;
  AvailableQuantity?: number;
  PromotionTeasers?: VtexPromotionTeaser[];
  /** Legacy teaser format (kept in rawData for forensics, not parsed). */
  Teasers?: unknown[];
}

interface VtexPromotionTeaser {
  Name?: string;
  Conditions?: {
    MinimumQuantity?: number;
    Parameters?: Array<{ Name?: string; Value?: string }>;
  };
  Effects?: {
    Parameters?: Array<{ Name?: string; Value?: string }>;
  };
}

interface VtexItem {
  itemId?: string;
  ean?: string;
  images?: Array<{ imageUrl?: string }>;
  sellers?: Array<{
    sellerId?: string;
    sellerName?: string;
    sellerDefault?: boolean;
    commertialOffer?: VtexCommertialOffer;
  }>;
}

interface VtexProduct {
  productId: string;
  productName?: string;
  brand?: string;
  linkText?: string;
  description?: string;
  link?: string;
  categories?: string[];
  productClusters?: Record<string, string>;
  /** Per-unit price as a single-element string array (e.g. ["1455.00"]). */
  pricePerUnit?: string[];
  items?: VtexItem[];
  // VTEX surfaces tons of dynamic specs as keyed string arrays — keep them as unknown.
  [key: string]: unknown;
}

// =============================================================================
// URL helpers
// =============================================================================

/**
 * Strip query/hash, normalize trailing slashes, lowercase host.
 * Carrefour product paths always end with /p; we leave that intact.
 */
function canonicalizeUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    u.search = '';
    u.hash = '';
    u.hostname = u.hostname.toLowerCase();
    u.pathname = u.pathname.replace(/\/+$/, ''); // drop trailing slashes
    return u.toString();
  } catch {
    return rawUrl;
  }
}

/** Extract the product slug ("foo-bar" from "/foo-bar/p"). */
function extractSlug(canonicalUrl: string): string | null {
  try {
    const path = new URL(canonicalUrl).pathname;
    const m = path.match(/\/([^/]+)\/p$/);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

// =============================================================================
// HTTP layer (shared between pagetype + catalog calls)
// =============================================================================

async function fetchVtex<T>(
  url: string,
  signal: AbortSignal | undefined,
  context: string,
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  if (signal) {
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json,text/plain,*/*',
        'Accept-Language': 'es-AR,es;q=0.9',
      },
      signal: controller.signal,
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new ScrapeError(
        'network_timeout',
        `Carrefour ${context} timed out after ${REQUEST_TIMEOUT_MS}ms (${url})`,
        { cause: err },
      );
    }
    throw new ScrapeError(
      'network_error',
      `Carrefour ${context} failed: ${(err as Error).message}`,
      { cause: err },
    );
  } finally {
    clearTimeout(timeoutId);
  }

  if (res.status === 404) {
    throw new ScrapeError(
      'product_not_found',
      `Carrefour ${context} returned 404 for ${url}`,
      { httpStatus: 404 },
    );
  }
  if (res.status === 429) {
    throw new ScrapeError(
      'rate_limited',
      `Carrefour ${context} returned 429 (rate limited)`,
      { httpStatus: 429 },
    );
  }
  if (res.status >= 500) {
    throw new ScrapeError(
      'site_server_error',
      `Carrefour ${context} returned ${res.status}`,
      { httpStatus: res.status },
    );
  }
  if (!res.ok) {
    throw new ScrapeError(
      'unknown',
      `Carrefour ${context} returned unexpected status ${res.status}`,
      { httpStatus: res.status },
    );
  }

  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new ScrapeError(
      'parse_failed',
      `Carrefour ${context} returned non-JSON body (first 200 chars: ${text.slice(0, 200)})`,
      { cause: err },
    );
  }
}

// =============================================================================
// Promotions
// =============================================================================

/**
 * VTEX exposes two promo arrays per offer:
 *   - PromotionTeasers (cleaner, structured)   -> we parse
 *   - Teasers          (legacy, oddly-shaped)  -> we ignore (kept in rawData)
 *
 * We pull % discount when present in Effects.Parameters; otherwise we just
 * keep the human-readable Name (e.g. "Tarjeta Carrefour 15%").
 */
function extractPromotions(offer: VtexCommertialOffer): Promotion[] {
  const out: Promotion[] = [];
  for (const teaser of offer.PromotionTeasers ?? []) {
    if (!teaser?.Name) continue;

    let discountPct: number | undefined;
    for (const p of teaser.Effects?.Parameters ?? []) {
      if (p.Name === 'PercentualDiscount' && p.Value) {
        const n = Number(p.Value);
        if (Number.isFinite(n)) discountPct = n;
      }
    }

    // Heuristic: many Carrefour teasers are payment-method offers
    // ("Tarjeta Carrefour 15%", "Tarjeta Naranja 20%"). We mark them as such
    // so the UI can group/filter them; otherwise it's a generic discount.
    const isPaymentMethod = /tarjeta|cred[ií]to|d[eé]bito|prepaga|naranja|cabal|amex|visa|master|santander|galicia|bna|bsf/i.test(
      teaser.Name,
    );

    out.push({
      type: isPaymentMethod ? 'payment_method' : 'discount',
      description: teaser.Name,
      ...(discountPct !== undefined ? { discountPct } : {}),
      raw: teaser,
    });
  }
  return out;
}

// =============================================================================
// Adapter
// =============================================================================

/**
 * Resolve a slug URL to its VTEX productId via the pagetype endpoint.
 * Called once per URL on first ingestion; the result is cached in the DB.
 */
async function resolveExternalId(
  canonicalUrl: string,
  signal?: AbortSignal,
): Promise<string> {
  const slug = extractSlug(canonicalizeUrl(canonicalUrl));
  if (!slug) {
    throw new ScrapeError(
      'unknown',
      `Carrefour URL doesn't look like a product page (expected /<slug>/p): ${canonicalUrl}`,
    );
  }
  const url = `${CARREFOUR_BASE}/api/catalog_system/pub/portal/pagetype/${encodeURIComponent(
    slug,
  )}/p`;
  const body = await fetchVtex<PageTypeResponse>(url, signal, 'pagetype lookup');

  if (body.pageType !== 'Product' || !body.id) {
    throw new ScrapeError(
      'product_not_found',
      `Carrefour pagetype returned non-Product (pageType=${body.pageType}, id=${
        body.id ?? 'null'
      }) for slug "${slug}"`,
    );
  }
  return body.id;
}

export const carrefourAdapter: SupermarketAdapter = {
  id: 'carrefour',
  name: 'Carrefour Argentina',

  canonicalizeUrl,
  resolveExternalId,

  searchByEan: (ean, signal) => vtexSearchByEan(CARREFOUR_BASE, ean, signal),

  async scrape(ctx: ScrapeContext): Promise<ScrapeResult> {
    if (!ctx.externalId) {
      throw new ScrapeError(
        'unknown',
        `Carrefour adapter requires external_id (productId), got empty.`,
      );
    }
    // VTEX regionalizes availability/price. Try the default sales channel
    // first; if the product is missing / price-less / out of stock there,
    // runWithGeoFallback re-scrapes from other AR zones via a VTEX regionId.
    return runWithGeoFallback({
      logger: ctx.logger,
      config: ctx.config.config,
      attempt: (zone) => scrapeCarrefourZone(ctx, zone),
    });
  },
};

/**
 * Single Carrefour catalog scrape, optionally scoped to a zone.
 *
 * - `zone === null`: the default catalog request (current behavior).
 * - `zone` provided: resolve that zone's postal code to a VTEX `regionId` and
 *   append it so the catalog returns sellers serving that region. If no region
 *   serves the CP, throw `product_not_found` so the fallback loop moves on.
 */
async function scrapeCarrefourZone(
  ctx: ScrapeContext,
  zone: Zone | null,
): Promise<ScrapeResult> {
  let url = `${CARREFOUR_BASE}/api/catalog_system/pub/products/search?fq=productId:${encodeURIComponent(
    ctx.externalId,
  )}`;
  let context = 'catalog lookup';

  if (zone) {
    const regionId = await resolveRegionId(CARREFOUR_BASE, zone.postalCode, ctx.signal);
    if (!regionId) {
      throw new ScrapeError(
        'product_not_found',
        `Carrefour: no VTEX region for zone ${zone.id} (CP ${zone.postalCode})`,
      );
    }
    url = withRegion(url, regionId);
    context = `catalog lookup [${zone.id}]`;
  }

  ctx.logger.debug({ url, zone: zone?.id ?? 'default' }, 'fetching Carrefour catalog');
  const body = await fetchVtex<VtexProduct[]>(url, ctx.signal, context);
  return parseCarrefourResponse(body, ctx);
}

// =============================================================================
// Pure parser — split out so we can unit-test against saved fixtures.
// =============================================================================

export function parseCarrefourResponse(
  body: VtexProduct[],
  ctx: Pick<ScrapeContext, 'externalId' | 'logger'>,
): ScrapeResult {
  const product = body?.[0];
  if (!product) {
    throw new ScrapeError(
      'product_not_found',
      `Carrefour catalog returned empty result for productId=${ctx.externalId}`,
    );
  }

  const item = product.items?.[0];
  if (!item) {
    throw new ScrapeError(
      'selector_failed',
      `Carrefour product has no items[] (productId=${ctx.externalId})`,
    );
  }

  // Pick the default seller's offer (the "official" Carrefour-sold price);
  // fall back to the first seller if the flag is missing.
  const seller =
    item.sellers?.find((s) => s.sellerDefault) ?? item.sellers?.[0];
  const offer = seller?.commertialOffer;
  if (!offer) {
    throw new ScrapeError(
      'selector_failed',
      `Carrefour item has no commertialOffer (productId=${ctx.externalId})`,
    );
  }

  // -- Price ---------------------------------------------------------------
  const price = offer.Price ?? offer.PriceWithoutDiscount;
  if (price === undefined || !Number.isFinite(price) || price <= 0) {
    throw new ScrapeError(
      'price_missing',
      `Carrefour offer has no usable price (productId=${ctx.externalId})`,
    );
  }

  // -- Stock ---------------------------------------------------------------
  // VTEX exposes both an availability flag and a numeric quantity. Treat
  // either being unavailable/zero as out of stock.
  const inStock =
    offer.IsAvailable === true && (offer.AvailableQuantity ?? 1) > 0;

  // -- List (crossed-out) price -------------------------------------------
  // VTEX returns ListPrice == Price when there's no discount; only emit it
  // when it actually differs (matches our snapshot semantics).
  let listPrice: number | undefined;
  if (
    typeof offer.ListPrice === 'number' &&
    Number.isFinite(offer.ListPrice) &&
    offer.ListPrice > price + 0.01
  ) {
    listPrice = offer.ListPrice;
  }

  // -- Per-unit price + label ---------------------------------------------
  let unitPrice: number | undefined;
  let unitPricePer: string | undefined;
  if (Array.isArray(product.pricePerUnit) && typeof product.pricePerUnit[0] === 'string') {
    const n = Number(product.pricePerUnit[0]);
    if (Number.isFinite(n) && n > 0) unitPrice = n;
  }
  // VTEX surfaces the unit label under a Spanish-language spec key.
  const unitLabel = product['Gramaje leyenda de conversión'];
  if (Array.isArray(unitLabel) && typeof unitLabel[0] === 'string') {
    unitPricePer = unitLabel[0].trim();
  }

  // -- Promotions ---------------------------------------------------------
  const promotions = extractPromotions(offer);

  // -- Master catalog data (used to backfill `products` row on first scrape) -
  const productInfo: ProductInfo = {};
  if (product.productName) productInfo.name = product.productName;
  if (product.brand) productInfo.brand = product.brand;
  if (item.ean) productInfo.ean = item.ean;
  // Categories come as ["/Limpieza/Lavandinas/", "/Limpieza/"]. The first is
  // most specific; we use the leaf segment as the human-readable category.
  if (Array.isArray(product.categories) && product.categories[0]) {
    const segments = product.categories[0].split('/').filter(Boolean);
    const leaf = segments[segments.length - 1];
    if (leaf) productInfo.category = leaf;
  }
  const imageUrl = item.images?.[0]?.imageUrl;
  if (imageUrl) productInfo.imageUrl = imageUrl;
  if (unitPricePer) productInfo.unit = unitPricePer;

  const metadata: Record<string, unknown> = {};
  if (product.linkText) metadata.linkText = product.linkText;
  if (product.link) metadata.link = product.link;
  if (item.itemId) metadata.itemId = item.itemId;
  if (Array.isArray(product.categories) && product.categories[0]) {
    metadata.categoryPath = product.categories[0];
  }
  if (Object.keys(metadata).length > 0) productInfo.metadata = metadata;

  const result: ScrapeResult = {
    price,
    inStock,
    currency: 'ARS',
    tierUsed: 'api',
    promotions,
    productInfo,
    rawData: {
      product,
    },
  };
  if (listPrice !== undefined) result.listPrice = listPrice;
  if (unitPrice !== undefined) result.unitPrice = unitPrice;
  if (unitPricePer) result.unitPricePer = unitPricePer;

  return result;
}
