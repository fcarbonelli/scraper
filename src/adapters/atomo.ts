/**
 * Átomo Conviene adapter (PrestaShop).
 *
 * Atomo runs PrestaShop and emits a clean schema.org `Product` JSON-LD block
 * on every product page. We do a single GET, regex out the JSON-LD, and read
 * everything from the parsed object — no JS rendering, no auth, no AJAX.
 *
 * URL pattern: `/atomo-ecommerce/<category>/<id>-<slug>---<EAN>.html`
 *   → `<id>` (PrestaShop product id) is the external_id.
 *   → `<EAN>` (13 digits) is also in the URL; we capture it as a fallback
 *      because PrestaShop also exposes it as `gtin13` in JSON-LD.
 *
 * Caveats:
 *   - The site sometimes returns 302 (redirect to home) when the id is
 *     unknown — treated as `product_not_found`, not as success.
 *   - The JSON-LD `brand.name` is broken in their theme (renders the literal
 *     "$shop.name"), so we ignore it and don't surface a brand for now.
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
const ATOMO_HOST = 'atomoconviene.com';
const ATOMO_BASE_URL = 'https://atomoconviene.com';

const USER_AGENT =
  'Mozilla/5.0 (compatible; PriceScraperBot/1.0; +https://example.com/bot)';

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
  description?: string;
  image?: string | string[] | { url?: string };
  offers?: JsonLdOffer | JsonLdOffer[];
}

interface JsonLdOffer {
  price?: string | number;
  priceCurrency?: string;
  availability?: string;
  url?: string;
  image?: string | string[];
  priceValidUntil?: string;
}

// =============================================================================
// URL helpers
// =============================================================================

/** Strip query/hash, lowercase host, normalize trailing slashes. */
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

/** Extract the leading numeric `<id>` of `<id>-<slug>---<EAN>.html`. */
function extractProductIdFromUrl(canonicalUrl: string): string | null {
  try {
    const path = new URL(canonicalUrl).pathname;
    // Last path segment ends with `.html`; id is the leading digits.
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
 * Fetch the product HTML. We do NOT auto-follow redirects so we can detect
 * the site's "unknown id → 302 to home" behavior as `product_not_found`.
 */
async function fetchAtomoHtml(
  url: string,
  signal: AbortSignal | undefined,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
  // The search path 301-redirects to the canonical results URL, so it must
  // follow redirects; the product (scrape) path keeps `manual` so an unknown
  // id redirecting to home is detected as `product_not_found`.
  followRedirects = false,
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
      redirect: followRedirects ? 'follow' : 'manual',
      signal: controller.signal,
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new ScrapeError(
        'network_timeout',
        `Atomo request timed out after ${timeoutMs}ms`,
        { cause: err },
      );
    }
    throw new ScrapeError(
      'network_error',
      `Atomo request failed: ${(err as Error).message}`,
      { cause: err },
    );
  } finally {
    clearTimeout(timeoutId);
  }

  // PrestaShop redirects to homepage when the id is unknown.
  if (res.status >= 300 && res.status < 400) {
    throw new ScrapeError(
      'product_not_found',
      `Atomo redirected (status=${res.status}) — product likely doesn't exist: ${url}`,
      { httpStatus: res.status },
    );
  }
  if (res.status === 404) {
    throw new ScrapeError('product_not_found', `Atomo returned 404 for ${url}`, {
      httpStatus: 404,
    });
  }
  if (res.status === 429) {
    throw new ScrapeError('rate_limited', `Atomo returned 429`, { httpStatus: 429 });
  }
  if (res.status >= 500) {
    throw new ScrapeError(
      'site_server_error',
      `Atomo returned ${res.status}`,
      { httpStatus: res.status },
    );
  }
  if (!res.ok) {
    throw new ScrapeError(
      'unknown',
      `Atomo returned unexpected status ${res.status}`,
      { httpStatus: res.status },
    );
  }
  return res.text();
}

// =============================================================================
// JSON-LD extraction
// =============================================================================

/** Match all `<script type="application/ld+json">…</script>` blocks. */
const JSON_LD_RE =
  /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

/**
 * Pull every JSON-LD block out of the page and return the first one that is
 * (or contains, in `@graph`) a `Product`. PrestaShop pages typically have 4+
 * blocks: Organization, WebSite, Product, BreadcrumbList.
 */
export function extractProductJsonLd(html: string): JsonLdProduct | null {
  const blocks: unknown[] = [];
  for (const m of html.matchAll(JSON_LD_RE)) {
    const raw = m[1];
    if (!raw) continue;
    try {
      blocks.push(JSON.parse(raw.trim()));
    } catch {
      // ignore malformed block; PrestaShop occasionally inlines comments
    }
  }
  for (const b of blocks) {
    const found = findProductNode(b);
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

// =============================================================================
// EAN search (bulk product discovery)
// =============================================================================

/**
 * Find a product by its EAN using PrestaShop's built-in search.
 *
 * Átomo's search (`?controller=search&s=<ean>`) indexes the barcode, so an EAN
 * query returns the matching product page. As with DIPA we only accept a result
 * whose product URL embeds the EAN — Átomo's friendly URLs end with
 * `---<EAN>.html`, so this guarantees an exact match instead of a fuzzy one.
 */
async function searchByEan(
  ean: string,
  signal?: AbortSignal,
): Promise<EanSearchResult | null> {
  // Hit the canonical results URL directly (the `?controller=search` form
  // 301-redirects here) and follow redirects so we land on the 200 results page.
  const searchUrl = `${ATOMO_BASE_URL}/atomo-ecommerce/busqueda?s=${encodeURIComponent(
    ean,
  )}`;

  let html: string;
  try {
    html = await fetchAtomoHtml(searchUrl, signal, SEARCH_TIMEOUT_MS, true);
  } catch {
    // Discovery treats any failure (incl. the "no results" redirect) as not found.
    return null;
  }

  // Accept only a product link whose URL embeds the EAN (…-<EAN>.html). The
  // leading `[^"]*` happily absorbs Átomo's `---` separator before the barcode.
  const re = new RegExp(`href="(https?://[^"]*-${ean}\\.html)"`, 'i');
  const m = html.match(re);
  if (!m?.[1]) return null;

  const url = canonicalizeUrl(m[1].replace(/&amp;/g, '&'));
  const externalId = extractProductIdFromUrl(url);
  return externalId ? { url, externalId } : { url };
}

// =============================================================================
// Adapter
// =============================================================================

export const atomoAdapter: SupermarketAdapter = {
  id: 'atomo',
  name: 'Átomo Conviene',

  canonicalizeUrl,

  searchByEan,

  async resolveExternalId(canonicalUrl: string): Promise<string> {
    const id = extractProductIdFromUrl(canonicalUrl);
    if (!id) {
      throw new ScrapeError(
        'unknown',
        `Atomo URL doesn't match /<...>/<id>-<slug>---<ean>.html: ${canonicalUrl}`,
      );
    }
    return id;
  },

  async scrape(ctx: ScrapeContext): Promise<ScrapeResult> {
    if (!ctx.externalUrl) {
      throw new ScrapeError(
        'unknown',
        `Atomo adapter requires external_url; got null for sku=${ctx.externalId}`,
      );
    }
    ctx.logger.debug({ url: ctx.externalUrl }, 'fetching Atomo product HTML');
    const html = await fetchAtomoHtml(ctx.externalUrl, ctx.signal);
    return parseAtomoHtml(html, ctx);
  },
};

// =============================================================================
// Pure parser — split for unit testing against saved HTML fixtures.
// =============================================================================

export function parseAtomoHtml(
  html: string,
  ctx: Pick<ScrapeContext, 'externalId' | 'externalUrl' | 'logger'>,
): ScrapeResult {
  const product = extractProductJsonLd(html);
  if (!product) {
    throw new ScrapeError(
      'selector_failed',
      `Atomo page has no Product JSON-LD block (sku=${ctx.externalId})`,
    );
  }

  // -- Offers may be a single object or an array; pick the first.
  const offer: JsonLdOffer | undefined = Array.isArray(product.offers)
    ? product.offers[0]
    : product.offers;

  // -- Price ---------------------------------------------------------------
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
      `Atomo JSON-LD has no usable price (sku=${ctx.externalId})`,
    );
  }
  const currency = offer?.priceCurrency || 'ARS';

  // -- Stock ---------------------------------------------------------------
  // schema.org availability strings: "https://schema.org/InStock", etc.
  const availability = offer?.availability ?? '';
  const inStock = /InStock(?!s)/i.test(availability);

  // -- Images: schema field can be a string, an array, or an object.
  let imageUrl: string | undefined;
  if (typeof product.image === 'string') {
    imageUrl = product.image;
  } else if (Array.isArray(product.image)) {
    const first = product.image[0];
    if (typeof first === 'string') imageUrl = first;
  } else if (product.image && typeof product.image === 'object') {
    imageUrl = (product.image as { url?: string }).url;
  }
  if (!imageUrl && offer?.image) {
    imageUrl = Array.isArray(offer.image) ? offer.image[0] : offer.image;
  }

  // -- Master catalog data -------------------------------------------------
  const productInfo: ProductInfo = {};
  if (product.name) productInfo.name = product.name.trim();
  if (product.gtin13) productInfo.ean = product.gtin13.trim();
  if (product.category) productInfo.category = product.category.trim();
  if (imageUrl) productInfo.imageUrl = imageUrl;
  // Note: brand is intentionally NOT extracted from JSON-LD because the
  // PrestaShop theme on Atomo emits the literal placeholder "$shop.name".

  // Fallback: derive EAN from URL pattern `---<EAN>.html` if JSON-LD lacks it.
  if (!productInfo.ean && ctx.externalUrl) {
    const m = ctx.externalUrl.match(/---(\d{8,14})\.html$/);
    if (m?.[1]) productInfo.ean = m[1];
  }

  const metadata: Record<string, unknown> = {};
  if (product.sku) metadata.prestashopSku = product.sku;
  if (offer?.priceValidUntil) metadata.priceValidUntil = offer.priceValidUntil;
  if (Object.keys(metadata).length > 0) productInfo.metadata = metadata;

  return {
    price,
    inStock,
    currency,
    tierUsed: 'html',
    promotions: [] as Promotion[],
    productInfo,
    rawData: { jsonLd: product },
  };
}

/** Hostname helper used by `detectSupermarket`. Exported for tests. */
export const ATOMO_HOSTNAME = ATOMO_HOST;
