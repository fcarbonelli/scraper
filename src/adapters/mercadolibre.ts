/**
 * MercadoLibre adapter — Ecomodico seller only.
 *
 * Per client instructions we track ONLY the products sold by the seller
 * "ECOMODICO" (seller_id 179907718 — the store at
 * listado.mercadolibre.com.ar/tienda/ecomodico). A MercadoLibre catalog page
 * aggregates many sellers, and the headline/buy-box price is whoever is winning
 * — which is usually NOT Ecomodico. So we never read the catalog buy-box; we
 * read Ecomodico's OWN offer.
 *
 * Price/stock: the catalog PDP pinned to Ecomodico's listing
 * (`/p/<catalogId>?item_id=<itemId>`, the stored external_url), rendered in a
 * headless browser (`mercadolibre-browser.ts`) and parsed by
 * `mercadolibre-pdp.ts`. Until 2026-11-23 this came from the official API
 * (`GET /products/<id>/items?seller_id=…`), but ML now refuses third-party
 * listing reads to every app (403 PolicyAgent / access_denied) — see
 * docs/CADENAS.md.
 *
 * The API (OAuth tokens from `mercadolibre-auth.ts`) is still used for catalog
 * metadata (`/products/<id>`), which keeps working.
 *
 * The stable `external_id` we persist is the catalog product id (MLA…); the
 * canonical URL is the catalog PDP `https://www.mercadolibre.com.ar/p/<id>`.
 */

import { ScrapeError } from '../shared/errors.js';
import { getAccessToken } from './mercadolibre-auth.js';
import { loadMlPage } from './mercadolibre-browser.js';
import { parseMlPdp } from './mercadolibre-pdp.js';
import type {
  ProductInfo,
  Promotion,
  ScrapeContext,
  ScrapeResult,
  SupermarketAdapter,
} from './types.js';

const API_BASE = 'https://api.mercadolibre.com';
const SITE_HOST = 'www.mercadolibre.com.ar';

/**
 * The only seller we track on MercadoLibre. Nickname "ECOMODICO"
 * (listado.mercadolibre.com.ar/tienda/ecomodico). To re-derive it, resolve any
 * of their listings' seller via `GET /users/<seller_id>` and confirm the
 * nickname, or read `seller_id` off `GET /products/<catalogId>/items`.
 */
const ECOMODICO_SELLER_ID = 179907718;

const REQUEST_TIMEOUT_MS = 15_000;

/** Markers ML puts in a 403 body when a policy (not the token) refuses the call. */
const POLICY_BLOCK_RE = /PolicyAgent|PA_UNAUTHORIZED|access_denied|ResourceDeprecated|restricted/i;

// =============================================================================
// API response shapes (only the fields we read are typed)
// =============================================================================

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
  /** Pre-discount ("original") price when the listing is on sale; else absent. */
  originalPrice?: number;
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
    if (res.status === 403) {
      // A valid token can still be refused by ML's API policies (a whole
      // endpoint closed to our app). Refreshing tokens won't fix that, so
      // don't report it as auth.
      const body = await res.text().catch(() => '');
      if (POLICY_BLOCK_RE.test(body)) {
        throw new ScrapeError(
          'selector_failed',
          `MercadoLibre API blocked ${path.split('?')[0]} by policy (not the token): ${body.slice(0, 160)}`,
          { httpStatus: 403 },
        );
      }
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

/**
 * Ecomodico's own listing URL for a catalog product: the shared catalog page
 * pinned to Ecomodico's specific offer via `?item_id=`. Without the pin the
 * page shows the cheapest seller (usually not Ecomodico), which is misleading
 * since we track Ecomodico's price. Falls back to the plain PDP when we don't
 * have the item id.
 */
export function ecomodicoListingUrl(catalogId: string, itemId: string | undefined): string {
  return itemId ? `${urlForId(catalogId)}?item_id=${encodeURIComponent(itemId)}` : urlForId(catalogId);
}

/**
 * Normalize host/protocol and drop tracking params — but KEEP `item_id`, which
 * pins Ecomodico's offer on the catalog page (see `ecomodicoListingUrl`). The
 * catalog product id lives in the path, so `resolveExternalId` is unaffected.
 */
function canonicalizeUrl(raw: string): string {
  const u = new URL(raw);
  u.protocol = 'https:';
  u.host = SITE_HOST;
  u.hash = '';
  const itemId = u.searchParams.get('item_id');
  u.search = '';
  if (itemId) u.searchParams.set('item_id', itemId);
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
 *
 * NB: since 2026-11-24 ML refuses this endpoint by policy (403 PolicyAgent →
 * `selector_failed`). Kept for `scripts/prune-ecomodico.ts` in case it reopens;
 * the daily scrape reads the PDP instead.
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

  // `original_price` is the regular (struck-through) price ML returns when the
  // listing is on sale; it is null/absent — or not above `price` — when there
  // is no discount. Keep it only when it is a genuine higher regular price.
  const originalPrice =
    typeof offer.original_price === 'number' && offer.original_price > price
      ? offer.original_price
      : undefined;

  return {
    itemId: offer.item_id,
    price,
    ...(originalPrice !== undefined ? { originalPrice } : {}),
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

/** The `item_id` pin stored on the mapping URL (Ecomodico's listing), if any. */
function pinnedItemId(externalUrl: string | null): string | undefined {
  if (!externalUrl) return undefined;
  try {
    return new URL(externalUrl).searchParams.get('item_id') ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Daily scrape: read ECOMODICO's own price from the catalog PDP pinned to their
 * listing, rendered in the shared headless browser.
 *
 * We do NOT use the catalog buy-box (that's whatever seller is winning). ML
 * silently ignores the `item_id` pin when that listing is gone and shows
 * another seller instead, so the displayed seller must be Ecomodico or we
 * surface `product_not_found` (they stopped selling it, or relisted it under a
 * new item id).
 */
async function scrape(ctx: ScrapeContext): Promise<ScrapeResult> {
  const id = ctx.externalId?.trim();
  if (!id) {
    throw new ScrapeError('product_not_found', 'MercadoLibre scrape called without an external_id');
  }

  const pinned = pinnedItemId(ctx.externalUrl);
  const url = ecomodicoListingUrl(id, pinned);
  const page = await loadMlPage(url, { logger: ctx.logger, ...(ctx.signal ? { signal: ctx.signal } : {}) });
  const parsed = parseMlPdp(page.html);
  if (!parsed) {
    throw new ScrapeError('selector_failed', `MercadoLibre PDP had no priced offer: ${url}`);
  }
  if (parsed.sellerId !== ECOMODICO_SELLER_ID) {
    throw new ScrapeError(
      'product_not_found',
      `MercadoLibre: the PDP shows seller ${parsed.sellerId ?? '?'} (item ${parsed.itemId ?? '?'}), ` +
        `not Ecomodico — listing ${pinned ?? '(no item_id)'} is no longer active`,
    );
  }
  const offer: EcomodicoOffer = {
    itemId: parsed.itemId,
    price: parsed.price,
    ...(parsed.originalPrice !== undefined ? { originalPrice: parsed.originalPrice } : {}),
    currency: parsed.currency,
  };

  // Metadata (brand/EAN) from the catalog API, which still works; fall back to
  // what the page itself shows. Never let it fail a scrape that has a price.
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
  if (!productInfo.name && parsed.name) productInfo.name = parsed.name;
  if (!productInfo.imageUrl && parsed.imageUrl) productInfo.imageUrl = parsed.imageUrl;

  // When Ecomodico's listing is on sale, `original_price` is the regular
  // (struck-through) price. Expose it as `listPrice` so the export shows
  // Precio_Regular (regular) and Precio_c_Oferta_1 (the sale price) — matching
  // every other chain's convention — instead of the sale price silently
  // masquerading as the regular price with no discount recorded.
  const promotions: Promotion[] = [];
  let listPrice: number | undefined;
  if (offer.originalPrice !== undefined && offer.originalPrice > offer.price) {
    listPrice = offer.originalPrice;
    const discountPct = Math.round((1 - offer.price / offer.originalPrice) * 100);
    promotions.push({
      type: 'discount',
      description: 'Oferta MercadoLibre',
      offerPrice: offer.price,
      ...(discountPct > 0 ? { discountPct } : {}),
    });
  }

  const result: ScrapeResult = {
    price: offer.price,
    inStock: parsed.inStock,
    currency: offer.currency,
    tierUsed: 'html',
    promotions,
    productInfo,
    rawData: {
      source: 'ecomodico_pdp',
      productId: id,
      itemId: offer.itemId,
      pinnedItemId: pinned,
      challenged: page.challenged,
      ...(offer.originalPrice !== undefined ? { originalPrice: offer.originalPrice } : {}),
    },
  };
  if (listPrice !== undefined) result.listPrice = listPrice;
  return result;
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

// No `searchByEan`: confirming that Ecomodico sells a catalog product needed
// `/products/<id>/items?seller_id=…`, which ML closed on 2026-11-24. Without
// that check discovery would map catalog products Ecomodico doesn't sell, so
// discovery and the weekly sweep skip this chain.
export const mercadolibreAdapter: SupermarketAdapter = {
  id: 'mercadolibre',
  name: 'Super MercadoLibre',
  canonicalizeUrl,
  resolveExternalId,
  scrape,
  probe,
};
