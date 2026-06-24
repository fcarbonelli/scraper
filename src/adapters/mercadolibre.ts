/**
 * MercadoLibre (Supermercado) adapter — official Products API.
 *
 * The public site is aggressively anti-bot, so we go through ML's official
 * REST API (api.mercadolibre.com) using OAuth tokens managed by
 * `mercadolibre-auth.ts`. Two endpoints do everything we need:
 *
 *   - Discovery by EAN:
 *       GET /products/search?status=active&site_id=MLA&product_identifier=<ean>
 *     Returns the matching *catalog product* (PDP), e.g. id "MLA14719808".
 *     Catalog products are unique per GTIN, so an EAN maps to at most one.
 *
 *   - Price/stock for a catalog product:
 *       GET /products/<id>
 *     The `buy_box_winner` object holds the currently-winning offer's price,
 *     currency and stock. When no offer is competing it's null (we then fall
 *     back to the `buy_box_winner_price_range` min, and otherwise report the
 *     product as out of stock).
 *
 * The stable `external_id` we persist is the catalog product id (MLA…). The
 * canonical URL is the catalog PDP `https://www.mercadolibre.com.ar/p/<id>`.
 */

import { ScrapeError } from '../shared/errors.js';
import { getAccessToken } from './mercadolibre-auth.js';
import { fetchMlPdp } from './mercadolibre-browser.js';
import type {
  EanSearchResult,
  ProductInfo,
  Promotion,
  ScrapeContext,
  ScrapeResult,
  SupermarketAdapter,
} from './types.js';

const API_BASE = 'https://api.mercadolibre.com';
const SITE_ID = 'MLA'; // Argentina
const SITE_HOST = 'www.mercadolibre.com.ar';

const REQUEST_TIMEOUT_MS = 15_000;
const SEARCH_TIMEOUT_MS = 20_000;

// =============================================================================
// API response shapes (only the fields we read are typed)
// =============================================================================

interface SearchResultItem {
  id?: string;
  status?: string;
  name?: string;
  domain_id?: string;
}

interface SearchResponse {
  results?: SearchResultItem[];
}

interface BuyBoxWinner {
  item_id?: string;
  seller_id?: number;
  price?: number;
  currency_id?: string;
  available_quantity?: number;
  condition?: string;
}

interface PriceRangeEntry {
  price?: number;
}

interface ProductAttribute {
  id?: string;
  value_name?: string;
}

interface ProductPicture {
  url?: string;
  secure_url?: string;
}

interface ProductDetail {
  id?: string;
  name?: string;
  status?: string;
  permalink?: string;
  domain_id?: string;
  buy_box_winner?: BuyBoxWinner | null;
  buy_box_winner_price_range?: {
    min?: PriceRangeEntry;
    max?: PriceRangeEntry;
  } | null;
  attributes?: ProductAttribute[];
  pictures?: ProductPicture[];
}

// =============================================================================
// Networking
// =============================================================================

/** Build a human-readable detail string from a fetch failure. */
function describeFetchError(err: unknown): string {
  const e = err as { message?: string; cause?: unknown };
  const cause = e.cause as { code?: string; message?: string } | undefined;
  const detail = cause?.code ?? cause?.message;
  return detail ? `${e.message ?? 'fetch failed'} (${detail})` : e.message ?? String(err);
}

/**
 * GET an API path with a Bearer token and return parsed JSON. On HTTP 401 we
 * force a token refresh once (the token may have been revoked) and retry.
 * HTTP failures are mapped to typed ScrapeErrors.
 */
async function fetchMlJson(
  path: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  retryOn401 = true,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = (): void => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const token = await getAccessToken();
    const res = await fetch(`${API_BASE}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      redirect: 'follow',
      signal: controller.signal,
    });

    if (res.status === 401 && retryOn401) {
      // Token may have been revoked/expired early — force a refresh + retry.
      await getAccessToken(true);
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      return fetchMlJson(path, signal, timeoutMs, false);
    }
    if (res.status === 401 || res.status === 403) {
      throw new ScrapeError('auth_required', `MercadoLibre returned HTTP ${res.status} (auth)`, {
        httpStatus: res.status,
      });
    }
    if (res.status === 429) {
      throw new ScrapeError('rate_limited', 'MercadoLibre rate-limited the request', {
        httpStatus: 429,
      });
    }
    if (res.status === 404) {
      throw new ScrapeError('product_not_found', 'MercadoLibre product not found (404)', {
        httpStatus: 404,
      });
    }
    if (res.status >= 500) {
      throw new ScrapeError('site_server_error', `MercadoLibre returned HTTP ${res.status}`, {
        httpStatus: res.status,
      });
    }
    if (!res.ok) {
      throw new ScrapeError('network_error', `MercadoLibre returned HTTP ${res.status}`, {
        httpStatus: res.status,
      });
    }

    try {
      return await res.json();
    } catch (err: unknown) {
      throw new ScrapeError('parse_failed', `MercadoLibre JSON parse failed: ${describeFetchError(err)}`, {
        cause: err,
      });
    }
  } catch (err: unknown) {
    if (err instanceof ScrapeError) throw err;
    if ((err as { name?: string }).name === 'AbortError') {
      throw new ScrapeError('network_timeout', `MercadoLibre request timed out after ${timeoutMs}ms`, {
        cause: err,
      });
    }
    throw new ScrapeError('network_error', `MercadoLibre request failed: ${describeFetchError(err)}`, {
      cause: err,
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

// =============================================================================
// URL helpers
// =============================================================================

/** Canonical catalog PDP URL for a product id. */
function urlForId(id: string): string {
  return `https://${SITE_HOST}/p/${id}`;
}

/** Strip tracking params and normalize host; keep the path (holds the id). */
function canonicalizeUrl(raw: string): string {
  const u = new URL(raw);
  u.protocol = 'https:';
  u.host = SITE_HOST;
  u.search = '';
  u.hash = '';
  return u.toString();
}

/**
 * Pull the catalog product id (MLA…) out of a ML URL. Catalog PDPs end in
 * `/p/MLA12345678`; some share links use `/up/MLAU…`. We grab the trailing
 * MLA-prefixed token in either case.
 */
function extractProductId(url: string): string | null {
  const m = url.match(/\/(?:p|up)\/(ML[A-Z]?\w+)/i);
  return m?.[1] ?? null;
}

// =============================================================================
// Parsing
// =============================================================================

/** Read the first attribute matching any of the given ids. */
function readAttr(attrs: ProductAttribute[] | undefined, ids: string[]): string | undefined {
  if (!attrs) return undefined;
  for (const a of attrs) {
    if (a.id && ids.includes(a.id) && a.value_name) return a.value_name;
  }
  return undefined;
}

/** Extract master-catalog metadata (no price) from a /products/<id> object. */
function extractProductInfo(product: ProductDetail): ProductInfo {
  const productInfo: ProductInfo = {};
  if (product.name) productInfo.name = product.name;
  const brand = readAttr(product.attributes, ['BRAND']);
  if (brand) productInfo.brand = brand;
  const gtin = readAttr(product.attributes, ['GTIN', 'EAN', 'UPC']);
  if (gtin) {
    const ean = gtin.replace(/\D/g, '');
    if (ean) productInfo.ean = ean;
  }
  const imageUrl = product.pictures?.[0]?.secure_url || product.pictures?.[0]?.url;
  if (imageUrl) productInfo.imageUrl = imageUrl;
  productInfo.metadata = {
    catalogProductId: product.id,
    domainId: product.domain_id,
  };
  return productInfo;
}

// =============================================================================
// Adapter methods
// =============================================================================

async function resolveExternalId(canonicalUrl: string): Promise<string> {
  const id = extractProductId(canonicalUrl);
  if (!id) {
    throw new ScrapeError('parse_failed', `MercadoLibre URL has no catalog product id: ${canonicalUrl}`);
  }
  return id;
}

/**
 * Daily scrape: read the price from the public product page via a real browser.
 *
 * The catalog API doesn't expose a price for this product category (buy-box is
 * null and the listings search is 403-gated), so pricing comes from the PDP.
 * We enrich it with catalog metadata from the API (one cheap GET) when possible.
 */
async function scrape(ctx: ScrapeContext): Promise<ScrapeResult> {
  const id = ctx.externalId?.trim();
  if (!id) {
    throw new ScrapeError('product_not_found', 'MercadoLibre scrape called without an external_id');
  }

  const pdp = await fetchMlPdp(id, ctx.logger, ctx.signal);

  // Best-effort metadata enrichment from the API (brand/EAN/image). Never let a
  // metadata hiccup fail a scrape that already has a valid price.
  let productInfo: ProductInfo = {};
  if (pdp.name) productInfo.name = pdp.name;
  if (pdp.imageUrl) productInfo.imageUrl = pdp.imageUrl;
  try {
    const json = await fetchMlJson(`/products/${encodeURIComponent(id)}`, ctx.signal, REQUEST_TIMEOUT_MS);
    const product = json as ProductDetail;
    if (product && typeof product === 'object' && product.id) {
      productInfo = { ...extractProductInfo(product), ...productInfo };
    }
  } catch {
    /* metadata is optional — price already in hand */
  }

  const promotions: Promotion[] = [];
  return {
    price: pdp.price,
    inStock: pdp.inStock,
    currency: pdp.currency,
    tierUsed: 'html',
    promotions,
    productInfo,
    rawData: { source: 'pdp', productId: id },
  };
}

/**
 * Lightweight ingest probe — metadata only, via a single cheap API GET. Must
 * NOT launch the browser (this runs inside the ingest request), so it never
 * touches the PDP path.
 */
async function probe(ctx: ScrapeContext): Promise<ProductInfo> {
  const id = ctx.externalId?.trim();
  if (!id) return {};
  try {
    const json = await fetchMlJson(`/products/${encodeURIComponent(id)}`, ctx.signal, REQUEST_TIMEOUT_MS);
    const product = json as ProductDetail;
    if (!product || typeof product !== 'object' || !product.id) return {};
    return extractProductInfo(product);
  } catch {
    return {};
  }
}

/**
 * EAN discovery via the catalog `product_identifier` search. A GTIN maps to at
 * most one active catalog product, so we take the first result. Returns its
 * canonical PDP URL plus the pre-resolved external_id (the catalog id).
 */
async function searchByEan(ean: string, signal?: AbortSignal): Promise<EanSearchResult | null> {
  const digits = ean.replace(/\D/g, '');
  if (!digits) return null;

  const params = new URLSearchParams({
    status: 'active',
    site_id: SITE_ID,
    product_identifier: digits,
  });
  let json: unknown;
  try {
    json = await fetchMlJson(`/products/search?${params.toString()}`, signal, SEARCH_TIMEOUT_MS);
  } catch (err) {
    // A 404 here means "no catalog product for this EAN" — not an error.
    if (err instanceof ScrapeError && err.type === 'product_not_found') return null;
    throw err;
  }

  const results = (json as SearchResponse)?.results ?? [];
  const match = results.find((r) => r.id) ?? undefined;
  if (!match?.id) return null;

  return { url: urlForId(match.id), externalId: match.id };
}

export const mercadolibreAdapter: SupermarketAdapter = {
  id: 'mercadolibre',
  name: 'Super MercadoLibre',
  canonicalizeUrl,
  resolveExternalId,
  scrape,
  probe,
  searchByEan,
};
