/**
 * MercadoLibre adapter — Ecomodico seller only, via the official Products API.
 *
 * Per client instructions we track ONLY the products sold by the seller
 * "ECOMODICO" (seller_id 179907718 — the store at
 * listado.mercadolibre.com.ar/tienda/ecomodico). A MercadoLibre catalog page
 * aggregates many sellers, and the headline/buy-box price is whoever is winning
 * — which is usually NOT Ecomodico. So we never read the catalog buy-box; we
 * read Ecomodico's OWN offer.
 *
 * All of this comes from ML's official REST API (api.mercadolibre.com) using
 * OAuth tokens from `mercadolibre-auth.ts` — no headless browser, no proxy
 * (the API is not the anti-bot storefront and works fine from the datacenter):
 *
 *   - Discovery by EAN:
 *       GET /products/search?status=active&site_id=MLA&product_identifier=<ean>
 *     Maps a GTIN to at most one *catalog product* (PDP), e.g. "MLA14719808".
 *     We then keep it ONLY if Ecomodico offers it (see below).
 *
 *   - Ecomodico's price/stock for a catalog product:
 *       GET /products/<catalogId>/items?seller_id=179907718
 *     Returns Ecomodico's single offer (item_id, price, currency) when they
 *     sell it, or HTTP 404 when they don't — an exact, one-call check that
 *     needs no pagination even on 100-seller catalog products.
 *
 * The stable `external_id` we persist is the catalog product id (MLA…); the
 * canonical URL is the catalog PDP `https://www.mercadolibre.com.ar/p/<id>`.
 */

import { ScrapeError } from '../shared/errors.js';
import { getAccessToken } from './mercadolibre-auth.js';
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

/**
 * The only seller we track on MercadoLibre. Nickname "ECOMODICO"
 * (listado.mercadolibre.com.ar/tienda/ecomodico). To re-derive it, resolve any
 * of their listings' seller via `GET /users/<seller_id>` and confirm the
 * nickname, or read `seller_id` off `GET /products/<catalogId>/items`.
 */
const ECOMODICO_SELLER_ID = 179907718;

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

/** One seller's offer on a catalog product (`/products/<id>/items`). */
interface ProductItemOffer {
  item_id?: string;
  seller_id?: number;
  price?: number;
  currency_id?: string;
  original_price?: number;
  available_quantity?: number;
}

interface ProductItemsResponse {
  paging?: { total?: number };
  results?: ProductItemOffer[];
}

interface ProductAttribute {
  id?: string;
  value_name?: string;
}

interface ProductPicture {
  url?: string;
  secure_url?: string;
}

/** Catalog product detail (`/products/<id>`) — used for metadata only. */
interface ProductDetail {
  id?: string;
  name?: string;
  status?: string;
  permalink?: string;
  domain_id?: string;
  attributes?: ProductAttribute[];
  pictures?: ProductPicture[];
}

/** Ecomodico's resolved offer for a catalog product. */
interface EcomodicoOffer {
  itemId: string | undefined;
  price: number;
  currency: string;
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

/**
 * Fetch Ecomodico's own offer for a catalog product, or null when Ecomodico
 * doesn't sell it. The `seller_id` filter returns exactly Ecomodico's offer
 * (never other sellers) and 404s when they have none — so we map that 404 to
 * `null` instead of letting it bubble as an error.
 */
export async function fetchEcomodicoOffer(
  catalogId: string,
  signal: AbortSignal | undefined,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<EcomodicoOffer | null> {
  let json: unknown;
  try {
    json = await fetchMlJson(
      `/products/${encodeURIComponent(catalogId)}/items?seller_id=${ECOMODICO_SELLER_ID}`,
      signal,
      timeoutMs,
    );
  } catch (err) {
    // 404 → Ecomodico has no offer (or the catalog product is gone). Both mean
    // "no Ecomodico price"; the caller decides how to classify it.
    if (err instanceof ScrapeError && err.type === 'product_not_found') return null;
    throw err;
  }

  const offer = (json as ProductItemsResponse)?.results?.[0];
  if (!offer || offer.seller_id !== ECOMODICO_SELLER_ID) return null;

  const price = typeof offer.price === 'number' ? offer.price : NaN;
  if (!Number.isFinite(price) || price <= 0) return null;

  return {
    itemId: offer.item_id,
    price,
    currency: offer.currency_id || 'ARS',
  };
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
 * Daily scrape: read ECOMODICO's own price for the catalog product via the API.
 *
 * We do NOT use the catalog buy-box (that's whatever seller is winning). If
 * Ecomodico no longer offers the product, we surface `product_not_found` — the
 * daily list is pruned to Ecomodico-sold products, so a disappearance means
 * they stopped selling it (or it went out of stock).
 */
async function scrape(ctx: ScrapeContext): Promise<ScrapeResult> {
  const id = ctx.externalId?.trim();
  if (!id) {
    throw new ScrapeError('product_not_found', 'MercadoLibre scrape called without an external_id');
  }

  const offer = await fetchEcomodicoOffer(id, ctx.signal, REQUEST_TIMEOUT_MS);
  if (!offer) {
    throw new ScrapeError(
      'product_not_found',
      `MercadoLibre: Ecomodico has no active offer for catalog product ${id}`,
    );
  }

  // Best-effort metadata enrichment from the catalog API (name/brand/EAN/image).
  // Never let a metadata hiccup fail a scrape that already has a valid price.
  let productInfo: ProductInfo = {};
  try {
    const json = await fetchMlJson(`/products/${encodeURIComponent(id)}`, ctx.signal, REQUEST_TIMEOUT_MS);
    const product = json as ProductDetail;
    if (product && typeof product === 'object' && product.id) {
      productInfo = extractProductInfo(product);
    }
  } catch {
    /* metadata is optional — price already in hand */
  }

  const promotions: Promotion[] = [];
  return {
    price: offer.price,
    // A returned offer is a live, buyable listing → in stock.
    inStock: true,
    currency: offer.currency,
    tierUsed: 'api',
    promotions,
    productInfo,
    rawData: { source: 'ecomodico_offer', productId: id, itemId: offer.itemId },
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
 * most one active catalog product. We only return it when ECOMODICO actually
 * sells that product — otherwise we'd re-pollute the list with non-Ecomodico
 * catalog products (e.g. via the weekly coverage sweep) right after pruning.
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

  // Keep the mapping only if Ecomodico offers this catalog product.
  const offer = await fetchEcomodicoOffer(match.id, signal, SEARCH_TIMEOUT_MS);
  if (!offer) return null;

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
