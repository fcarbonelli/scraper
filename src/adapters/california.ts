/**
 * Supermercado California adapter (WooCommerce, EAN-as-SKU).
 *
 * California S.A. (californiasa.com.ar, NEA region) runs WooCommerce. Two facts
 * make this the cleanest adapter we have:
 *
 *   1. The WooCommerce `sku` IS the product's EAN/barcode (e.g. the AYUDIN gel
 *      product has sku "7793253003807", and its image is even named
 *      `7793253003807.jpg`).
 *   2. The public, read-only WooCommerce **Store API** is enabled:
 *        GET /wp-json/wc/store/v1/products?sku=<ean>   → exact match (1 item)
 *        GET /wp-json/wc/store/v1/products?slug=<slug> → resolve id from URL
 *        GET /wp-json/wc/store/v1/products/<id>        → single product detail
 *
 * So we read everything from JSON — no HTML parsing, no JS rendering, no auth.
 *
 * IMPORTANT — the front-end `?s=<ean>` search does NOT index the SKU (both real
 * and bogus EANs return "no results"), which is why EAN discovery goes through
 * the Store API `?sku=` filter instead of the storefront search.
 *
 * Store API price quirk: prices are integers in the currency's *minor* unit
 * (cents). `price: "288000"` with `currency_minor_unit: 2` means ARS 2880.00.
 *
 * URL pattern: `/producto/<slug>/`. The stable `external_id` we persist is the
 * numeric WooCommerce product id (resolved via the Store API).
 */

import { ScrapeError } from '../shared/errors.js';
import type {
  EanSearchResult,
  ProductInfo,
  Promotion,
  ScrapeContext,
  ScrapeResult,
  SupermarketAdapter,
} from './types.js';

const REQUEST_TIMEOUT_MS = 15_000;
const SEARCH_TIMEOUT_MS = 20_000;

const CALIFORNIA_HOST = 'californiasa.com.ar';
const BASE_URL = 'https://www.californiasa.com.ar';
const STORE_API = `${BASE_URL}/wp-json/wc/store/v1/products`;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// =============================================================================
// Store API response shapes (only the fields we read are typed)
// =============================================================================

interface StorePrices {
  /** Integer string in the currency minor unit (e.g. "288000" = 2880.00). */
  price?: string;
  regular_price?: string;
  sale_price?: string;
  currency_code?: string;
  /** Decimal places to shift `price`/`regular_price` by (usually 2). */
  currency_minor_unit?: number;
}

interface StoreImage {
  src?: string;
}

interface StoreCategory {
  name?: string;
}

interface StoreProduct {
  id?: number;
  name?: string;
  /** The barcode/EAN for this chain. */
  sku?: string;
  permalink?: string;
  is_in_stock?: boolean;
  prices?: StorePrices;
  images?: StoreImage[];
  categories?: StoreCategory[];
}

// =============================================================================
// Networking
// =============================================================================

/** Build a human-readable detail string from a fetch failure (surfaces cause). */
function describeFetchError(err: unknown): string {
  const e = err as { message?: string; cause?: unknown };
  const cause = e.cause as { code?: string; message?: string } | undefined;
  const detail = cause?.code ?? cause?.message;
  return detail ? `${e.message ?? 'fetch failed'} (${detail})` : e.message ?? String(err);
}

/**
 * GET a Store API URL and return parsed JSON. Maps HTTP failures to typed
 * ScrapeErrors so the worker can pick the right retry policy.
 */
async function fetchCaliforniaJson(
  url: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Abort our request if the caller aborts theirs.
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json,text/plain,*/*',
        'Accept-Language': 'es-AR,es;q=0.9',
      },
      redirect: 'follow',
      signal: controller.signal,
    });

    if (res.status === 429) {
      throw new ScrapeError('rate_limited', 'California rate-limited the request', {
        httpStatus: 429,
      });
    }
    if (res.status === 404) {
      throw new ScrapeError('product_not_found', 'California product not found (404)', {
        httpStatus: 404,
      });
    }
    if (res.status >= 500) {
      throw new ScrapeError('site_server_error', `California returned HTTP ${res.status}`, {
        httpStatus: res.status,
      });
    }
    if (!res.ok) {
      throw new ScrapeError('network_error', `California returned HTTP ${res.status}`, {
        httpStatus: res.status,
      });
    }

    try {
      return await res.json();
    } catch (err: unknown) {
      throw new ScrapeError('parse_failed', `California JSON parse failed: ${describeFetchError(err)}`, {
        cause: err,
      });
    }
  } catch (err: unknown) {
    if (err instanceof ScrapeError) throw err;
    // AbortError → distinguish caller-cancellation from our own timeout.
    if ((err as { name?: string }).name === 'AbortError') {
      throw new ScrapeError('network_timeout', `California request timed out after ${timeoutMs}ms`, {
        cause: err,
      });
    }
    throw new ScrapeError('network_error', `California request failed: ${describeFetchError(err)}`, {
      cause: err,
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

// =============================================================================
// Parsing helpers
// =============================================================================

/** Decode the handful of HTML entities WooCommerce leaves in product names. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#8217;/g, '\u2019')
    .replace(/&aacute;/g, 'á')
    .replace(/&eacute;/g, 'é')
    .replace(/&iacute;/g, 'í')
    .replace(/&oacute;/g, 'ó')
    .replace(/&uacute;/g, 'ú')
    .replace(/&ntilde;/g, 'ñ')
    .trim();
}

/** Convert a Store API minor-unit integer string to a decimal number. */
function minorToDecimal(value: string | undefined, minorUnit: number): number {
  if (value == null) return NaN;
  const n = Number(value);
  if (!Number.isFinite(n)) return NaN;
  return n / 10 ** minorUnit;
}

/** Build a ScrapeResult from a Store API product object. */
export function parseCaliforniaProduct(
  product: StoreProduct,
  _ctx: Pick<ScrapeContext, 'externalId' | 'externalUrl'>,
): ScrapeResult {
  const prices = product.prices ?? {};
  const minorUnit = prices.currency_minor_unit ?? 2;

  const price = minorToDecimal(prices.price, minorUnit);
  if (!Number.isFinite(price) || price <= 0) {
    throw new ScrapeError('price_missing', 'California product has no usable price');
  }

  const regular = minorToDecimal(prices.regular_price, minorUnit);
  // Only treat the regular price as a "list price" if it's a genuine markdown.
  const listPrice =
    Number.isFinite(regular) && regular > price + 0.009 ? regular : undefined;

  const currency = prices.currency_code || 'ARS';
  // Default to in-stock unless the API explicitly says otherwise.
  const inStock = product.is_in_stock !== false;

  const productInfo: ProductInfo = {};
  if (product.name) productInfo.name = decodeEntities(product.name);
  // The chain stores the EAN as the WooCommerce SKU.
  if (product.sku) {
    const ean = product.sku.replace(/\D/g, '');
    if (ean) productInfo.ean = ean;
  }
  const category = product.categories?.[0]?.name;
  if (category) productInfo.category = decodeEntities(category);
  const imageUrl = product.images?.[0]?.src;
  if (imageUrl) productInfo.imageUrl = imageUrl;
  productInfo.metadata = { wcProductId: product.id, sku: product.sku };

  const promotions: Promotion[] = [];
  if (listPrice) {
    promotions.push({
      type: 'discount',
      description: `Precio de oferta (antes $${listPrice.toFixed(2)})`,
      discountPct: Math.round((1 - price / listPrice) * 100),
    });
  }

  const result: ScrapeResult = {
    price,
    inStock,
    currency,
    tierUsed: 'api',
    promotions,
    productInfo,
    rawData: { storeApi: product as unknown as Record<string, unknown> },
  };
  if (listPrice) result.listPrice = listPrice;
  return result;
}

// =============================================================================
// URL helpers
// =============================================================================

/** Strip tracking params / fragments and normalize host + trailing slash. */
function canonicalizeUrl(raw: string): string {
  const u = new URL(raw);
  u.protocol = 'https:';
  u.host = 'www.californiasa.com.ar';
  u.search = '';
  u.hash = '';
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  return u.toString();
}

/** Pull the `<slug>` out of a `/producto/<slug>/` path. */
function extractSlug(url: string): string | null {
  const m = new URL(url).pathname.match(/\/producto\/([^/]+)\/?$/);
  return m?.[1] ?? null;
}

/** Coerce the Store API list response into an array of products. */
function asProductArray(json: unknown): StoreProduct[] {
  return Array.isArray(json) ? (json as StoreProduct[]) : [];
}

// =============================================================================
// Adapter
// =============================================================================

/**
 * Resolve a canonical `/producto/<slug>/` URL to the numeric WooCommerce id we
 * persist as `external_id`. One extra HTTP call, made once at ingest time.
 */
async function resolveExternalId(canonicalUrl: string, signal?: AbortSignal): Promise<string> {
  const slug = extractSlug(canonicalUrl);
  if (!slug) {
    throw new ScrapeError('parse_failed', `California URL has no product slug: ${canonicalUrl}`);
  }
  const json = await fetchCaliforniaJson(
    `${STORE_API}?slug=${encodeURIComponent(slug)}`,
    signal,
    REQUEST_TIMEOUT_MS,
  );
  const product = asProductArray(json)[0];
  if (!product?.id) {
    throw new ScrapeError('product_not_found', `California product not found for slug "${slug}"`);
  }
  return String(product.id);
}

/** Daily scrape: fetch the single product by its WooCommerce id. */
async function scrape(ctx: ScrapeContext): Promise<ScrapeResult> {
  const id = ctx.externalId?.trim();
  if (!id) {
    throw new ScrapeError('product_not_found', 'California scrape called without an external_id');
  }
  const json = await fetchCaliforniaJson(
    `${STORE_API}/${encodeURIComponent(id)}`,
    ctx.signal,
    REQUEST_TIMEOUT_MS,
  );
  const product = json as StoreProduct;
  if (!product || typeof product !== 'object' || !product.id) {
    throw new ScrapeError('product_not_found', `California product ${id} returned no data`);
  }
  return parseCaliforniaProduct(product, ctx);
}

/** Lightweight ingest probe — same data as scrape, minus the price guarantee. */
async function probe(ctx: ScrapeContext): Promise<ProductInfo> {
  try {
    const result = await scrape(ctx);
    return result.productInfo ?? {};
  } catch {
    return {};
  }
}

/**
 * EAN discovery via the Store API `?sku=` filter (the SKU is the EAN).
 *
 * Returns the canonical product URL plus the pre-resolved external_id so the
 * discover script skips the extra `resolveExternalId` call. Returns null when
 * no product carries that EAN. Network/HTTP errors propagate so discovery can
 * surface them rather than silently counting them as "not found".
 */
async function searchByEan(ean: string, signal?: AbortSignal): Promise<EanSearchResult | null> {
  const digits = ean.replace(/\D/g, '');
  if (!digits) return null;

  const json = await fetchCaliforniaJson(
    `${STORE_API}?sku=${encodeURIComponent(digits)}`,
    signal,
    SEARCH_TIMEOUT_MS,
  );
  const product = asProductArray(json)[0];
  if (!product?.id || !product.permalink) return null;

  return { url: canonicalizeUrl(product.permalink), externalId: String(product.id) };
}

export const californiaAdapter: SupermarketAdapter = {
  id: 'california',
  name: 'Supermercado California',
  canonicalizeUrl,
  resolveExternalId,
  scrape,
  probe,
  searchByEan,
};

export { CALIFORNIA_HOST };
