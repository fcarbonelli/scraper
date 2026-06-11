/**
 * Parodi / DIPA adapter (PrestaShop).
 *
 * DIPA (cordoba.dipa.ar, "Parodi SRL") runs PrestaShop and emits a schema.org
 * `Product` JSON-LD block on every product page — including `gtin13` (the EAN),
 * `sku`, `brand`, and `offers.price`. We GET the page, regex out the JSON-LD,
 * and read everything from there (no JS rendering, no auth).
 *
 * URL pattern: `/<category>/<id>-<slug>-<EAN>.html`
 *   e.g. `/desinfectantes-en-aerosol/7201-desinfayudin-...-7793253005054.html`
 *   → `<id>` (PrestaShop product id, "7201") is the external_id.
 *   → `<EAN>` (13 digits) is the last hyphen-segment before `.html`.
 *
 * EAN discovery: PrestaShop's built-in search (`?controller=search&s=<ean>`)
 * indexes the barcode. We confirm the match by requiring the result's product
 * URL to embed the EAN, so we never map a client EAN to a fuzzy near-match.
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

const REQUEST_TIMEOUT_MS = 20_000;
const SEARCH_TIMEOUT_MS = 20_000;
const DIPA_HOST = 'cordoba.dipa.ar';
const DIPA_BASE_URL = 'https://cordoba.dipa.ar';

// Present a realistic Chrome UA to avoid WAF blocks on non-browser agents.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// =============================================================================
// JSON-LD shapes (only the fields we read are typed)
// =============================================================================

interface JsonLdNode {
  '@type'?: string | string[];
  [key: string]: unknown;
}

interface JsonLdProduct extends JsonLdNode {
  name?: string;
  sku?: string;
  gtin13?: string;
  category?: string;
  image?: string | string[] | { url?: string };
  brand?: { name?: string } | string;
  offers?: JsonLdOffer | JsonLdOffer[];
}

interface JsonLdOffer {
  price?: string | number;
  priceCurrency?: string;
  availability?: string;
}

// =============================================================================
// URL helpers
// =============================================================================

/** Strip query/hash, lowercase host, trim trailing slashes. */
function canonicalizeUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    u.search = '';
    u.hash = '';
    u.hostname = u.hostname.toLowerCase();
    u.pathname = u.pathname.replace(/\/+$/, '');
    return u.toString();
  } catch {
    return rawUrl;
  }
}

/** Extract the leading numeric `<id>` of `<id>-<slug>-<EAN>.html`. */
function extractProductIdFromUrl(canonicalUrl: string): string | null {
  try {
    const path = new URL(canonicalUrl).pathname;
    const last = path.split('/').filter(Boolean).pop();
    if (!last) return null;
    const m = last.match(/^(\d+)-/);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

// =============================================================================
// HTTP layer
// =============================================================================

/**
 * Fetch HTML. We do NOT auto-follow redirects so the PrestaShop "unknown id →
 * 302 to home" behavior is detectable as `product_not_found`.
 */
async function fetchDipaHtml(
  url: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) {
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,*/*',
        'Accept-Language': 'es-AR,es;q=0.9',
      },
      redirect: 'manual',
      signal: controller.signal,
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new ScrapeError(
        'network_timeout',
        `DIPA request timed out after ${timeoutMs}ms`,
        { cause: err },
      );
    }
    throw new ScrapeError(
      'network_error',
      `DIPA request failed: ${(err as Error).message}`,
      { cause: err },
    );
  } finally {
    clearTimeout(timeoutId);
  }

  if (res.status >= 300 && res.status < 400) {
    throw new ScrapeError(
      'product_not_found',
      `DIPA redirected (status=${res.status}) — product likely doesn't exist: ${url}`,
      { httpStatus: res.status },
    );
  }
  if (res.status === 404) {
    throw new ScrapeError('product_not_found', `DIPA returned 404 for ${url}`, {
      httpStatus: 404,
    });
  }
  if (res.status === 429) {
    throw new ScrapeError('rate_limited', `DIPA returned 429`, { httpStatus: 429 });
  }
  if (res.status >= 500) {
    throw new ScrapeError('site_server_error', `DIPA returned ${res.status}`, {
      httpStatus: res.status,
    });
  }
  if (!res.ok) {
    throw new ScrapeError('unknown', `DIPA returned status ${res.status}`, {
      httpStatus: res.status,
    });
  }
  return res.text();
}

// =============================================================================
// JSON-LD extraction
// =============================================================================

const JSON_LD_RE =
  /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

/** Pull the first Product JSON-LD block (PrestaShop emits 4: Org, WebPage, Breadcrumb, Product). */
export function extractProductJsonLd(html: string): JsonLdProduct | null {
  for (const m of html.matchAll(JSON_LD_RE)) {
    const raw = m[1];
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.trim());
    } catch {
      continue;
    }
    const found = findProductNode(parsed);
    if (found) return found;
  }
  return null;
}

function findProductNode(node: unknown): JsonLdProduct | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findProductNode(item);
      if (found) return found;
    }
    return null;
  }
  const o = node as JsonLdProduct & { '@graph'?: unknown };
  if (typesIncludeProduct(o['@type'])) return o;
  if (o['@graph']) return findProductNode(o['@graph']);
  return null;
}

function typesIncludeProduct(t: unknown): boolean {
  if (typeof t === 'string') return t === 'Product';
  if (Array.isArray(t)) return t.includes('Product');
  return false;
}

/**
 * Parse an Argentine-formatted price string ("$ 2.815,74" → 2815.74).
 * Dots are thousands separators, comma is the decimal separator.
 */
function parseArPrice(raw: string): number {
  const digits = raw.replace(/[^\d.,]/g, '').replace(/\./g, '').replace(',', '.');
  const n = Number(digits);
  return Number.isFinite(n) ? n : NaN;
}

/** Best-effort: PrestaShop renders the pre-discount price as `.regular-price`. */
const REGULAR_PRICE_RE =
  /class=['"][^'"]*\bregular-price\b[^'"]*['"][^>]*>([^<]+)</i;

// =============================================================================
// EAN search (bulk product discovery)
// =============================================================================

async function searchByEan(
  ean: string,
  signal?: AbortSignal,
): Promise<EanSearchResult | null> {
  const searchUrl = `${DIPA_BASE_URL}/buscar?controller=search&s=${encodeURIComponent(ean)}`;

  let html: string;
  try {
    html = await fetchDipaHtml(searchUrl, signal, SEARCH_TIMEOUT_MS);
  } catch {
    // Discovery treats any failure as "not found".
    return null;
  }

  // Only accept a result whose product URL embeds the EAN. PrestaShop's link
  // rewrite ends product URLs with `-<EAN>.html`, so this guarantees an exact
  // match and avoids mapping the client EAN to a fuzzy near-match.
  const re = new RegExp(
    `href="(https?://[^"]*-${ean}\\.html)"`,
    'i',
  );
  const m = html.match(re);
  if (!m?.[1]) return null;

  const url = canonicalizeUrl(m[1].replace(/&amp;/g, '&'));
  const externalId = extractProductIdFromUrl(url);
  return externalId ? { url, externalId } : { url };
}

// =============================================================================
// Adapter
// =============================================================================

export const parodiAdapter: SupermarketAdapter = {
  id: 'parodi',
  name: 'Parodi (DIPA)',

  canonicalizeUrl,

  searchByEan,

  async resolveExternalId(canonicalUrl: string): Promise<string> {
    const id = extractProductIdFromUrl(canonicalUrl);
    if (!id) {
      throw new ScrapeError(
        'unknown',
        `DIPA URL doesn't match /<...>/<id>-<slug>-<ean>.html: ${canonicalUrl}`,
      );
    }
    return id;
  },

  async scrape(ctx: ScrapeContext): Promise<ScrapeResult> {
    if (!ctx.externalUrl) {
      throw new ScrapeError(
        'unknown',
        `DIPA adapter requires external_url; got null for sku=${ctx.externalId}`,
      );
    }
    ctx.logger.debug({ url: ctx.externalUrl }, 'fetching DIPA product HTML');
    const html = await fetchDipaHtml(ctx.externalUrl, ctx.signal, REQUEST_TIMEOUT_MS);
    return parseDipaHtml(html, ctx);
  },
};

// =============================================================================
// Pure parser — split for unit testing against saved HTML fixtures.
// =============================================================================

export function parseDipaHtml(
  html: string,
  ctx: Pick<ScrapeContext, 'externalId' | 'externalUrl' | 'logger'>,
): ScrapeResult {
  const product = extractProductJsonLd(html);
  if (!product) {
    throw new ScrapeError(
      'selector_failed',
      `DIPA page has no Product JSON-LD block (sku=${ctx.externalId})`,
    );
  }

  const offer: JsonLdOffer | undefined = Array.isArray(product.offers)
    ? product.offers[0]
    : product.offers;

  // -- Price (JSON-LD uses a dot-decimal numeric string) --------------------
  const priceRaw = offer?.price;
  const price =
    typeof priceRaw === 'number'
      ? priceRaw
      : typeof priceRaw === 'string'
        ? Number(priceRaw)
        : NaN;
  if (!Number.isFinite(price) || price <= 0) {
    throw new ScrapeError(
      'price_missing',
      `DIPA JSON-LD has no usable price (sku=${ctx.externalId})`,
    );
  }
  const currency = offer?.priceCurrency || 'ARS';

  // -- List price (pre-discount), best-effort from the DOM ------------------
  let listPrice: number | undefined;
  const regMatch = html.match(REGULAR_PRICE_RE);
  if (regMatch?.[1]) {
    const parsed = parseArPrice(regMatch[1]);
    // Only treat it as a markdown when it's meaningfully above the sale price.
    if (Number.isFinite(parsed) && parsed > price + 0.01) listPrice = parsed;
  }

  // -- Stock ----------------------------------------------------------------
  const availability = offer?.availability ?? '';
  const inStock = availability ? /InStock/i.test(availability) : true;

  // -- Image ----------------------------------------------------------------
  let imageUrl: string | undefined;
  if (typeof product.image === 'string') {
    imageUrl = product.image;
  } else if (Array.isArray(product.image)) {
    const first = product.image[0];
    if (typeof first === 'string') imageUrl = first;
  } else if (product.image && typeof product.image === 'object') {
    imageUrl = (product.image as { url?: string }).url;
  }

  // -- Brand (PrestaShop emits `brand.name`) --------------------------------
  let brand: string | undefined;
  if (typeof product.brand === 'string') brand = product.brand;
  else if (product.brand && typeof product.brand === 'object') brand = product.brand.name;

  // -- Master catalog data --------------------------------------------------
  const productInfo: ProductInfo = {};
  if (product.name) productInfo.name = product.name.trim();
  if (brand) productInfo.brand = brand.trim();
  if (product.gtin13) productInfo.ean = product.gtin13.trim();
  if (product.category) productInfo.category = product.category.trim();
  if (imageUrl) productInfo.imageUrl = imageUrl;

  // Fallback: derive EAN from the URL pattern `-<EAN>.html`.
  if (!productInfo.ean && ctx.externalUrl) {
    const m = ctx.externalUrl.match(/-(\d{8,14})\.html$/);
    if (m?.[1]) productInfo.ean = m[1];
  }

  const metadata: Record<string, unknown> = {};
  if (product.sku) metadata.prestashopSku = product.sku;
  if (Object.keys(metadata).length > 0) productInfo.metadata = metadata;

  const result: ScrapeResult = {
    price,
    inStock,
    currency,
    tierUsed: 'html',
    promotions: [] as Promotion[],
    productInfo,
    rawData: { jsonLd: product },
  };
  if (listPrice !== undefined) result.listPrice = listPrice;

  return result;
}

/** Hostname helper used by `detectSupermarket`. Exported for tests. */
export const DIPA_HOSTNAME = DIPA_HOST;
