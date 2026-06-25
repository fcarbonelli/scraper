/**
 * La Anónima Online adapter (bespoke platform).
 *
 * laanonima.com.ar runs a custom storefront (not VTEX/Magento/PrestaShop) but
 * emits a clean schema.org `Product` JSON-LD block on every product page —
 * including `gtin` (the EAN), `sku`, `brand.name`, `offers.price` and
 * availability. We GET the page, regex out the JSON-LD, and read everything
 * from there (no JS rendering, no auth).
 *
 * URL pattern: `/<slug>/art_<id>/`
 *   e.g. `/aerosol-desinfectante-...-x-332-cc/art_2676140/`
 *   → `<id>` (the numeric article id, also the JSON-LD `sku`) is the external_id.
 *
 * EAN discovery: the site search lives at `/buscar/<term>` and indexes the
 * barcode. IMPORTANT — when a term has no match the site does NOT return an
 * empty page; it renders a "No encontramos resultados" banner plus a
 * "Quizás podría interesarte" carousel of ~unrelated recommended products. So
 * `searchByEan` must detect that banner FIRST and bail, otherwise it would map
 * every missing EAN onto a random recommended product. Only when the banner is
 * absent do we take the (single) result's `art_<id>` link as the match.
 *
 * Location note (corrected 2026-06): the SUPER (grocery) catalog IS sucursal-
 * scoped, and the lever is the `Id-Sucursal-Super` cookie — NOT the postal-code
 * cookies (those do nothing on their own). With no super sucursal selected the
 * site has `super:null` and 302s every super product to the homepage, regardless
 * of egress IP. Setting `Id-Sucursal-Super=<id>` (+ `Id-Sucursal-Super-DisponibleYa`,
 * `seleccionocp=1`) reveals the product and its price for any branch that stocks
 * it. Verified live: a plain GET with just those cookies recovers products that
 * otherwise redirect home. Different branches carry different assortments (a SKU
 * stocked in Neuquén may be absent in Bariloche), so when the default attempt
 * 302s home / yields no price we sweep a list of super sucursal ids (Patagonia +
 * NEA — BA/Córdoba/Mendoza have no super catalog) until one resolves. The sweep
 * is purely additive: the first attempt keeps today's IP-default behaviour, so
 * products that already work are untouched; the sweep only RECOVERS failures.
 *
 * Stale-id healing: La Anónima periodically REPLACES a product's `art_<id>`
 * while the EAN stays constant. The old PDP then 302s to the homepage from EVERY
 * sucursal, so once the full sweep still home-redirects we report
 * `product_not_found` and `scripts/rediscover-products.ts` re-resolves the EAN to
 * the new article and re-maps the row in place.
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
const LA_ANONIMA_HOST = 'laanonima.com.ar';
const LA_ANONIMA_BASE_URL = 'https://www.laanonima.com.ar';

// Present a realistic Chrome UA — the site's WAF 403s non-browser agents.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// The "no results" banner the site renders for an unmatched search term.
const NO_RESULTS_RE = /No encontramos resultados/i;

// -----------------------------------------------------------------------------
// Super sucursal selection
// -----------------------------------------------------------------------------
// The super (grocery) catalog is scoped by the `Id-Sucursal-Super` cookie. When
// the default attempt 302s home / has no price, we retry against each of these
// branch ids until one stocks the product. IDs span La Anónima's super footprint
// (Patagonia + NEA); discovered live from /sucursal/<cp>. Override the order/set
// with LA_ANONIMA_SUCURSAL_FALLBACKS="8,22,4,…" if the assortment shifts.
const DEFAULT_SUCURSAL_FALLBACKS = [8, 22, 4, 47, 33, 59, 32, 165, 164, 6];

const SUCURSAL_FALLBACKS: number[] = (() => {
  const raw = process.env.LA_ANONIMA_SUCURSAL_FALLBACKS;
  if (!raw) return DEFAULT_SUCURSAL_FALLBACKS;
  const ids = raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  return ids.length > 0 ? ids : DEFAULT_SUCURSAL_FALLBACKS;
})();

// Optional: force a specific super sucursal as the PRIMARY attempt (deterministic
// pricing). Unset → the first attempt uses the egress IP's default sucursal,
// preserving today's behaviour for products that already scrape fine.
const PRIMARY_SUCURSAL: number | null = (() => {
  const raw = process.env.LA_ANONIMA_SUCURSAL_SUPER;
  if (!raw) return null;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n > 0 ? n : null;
})();

/** Cookie header that scopes the storefront to a given super sucursal branch. */
function buildSucursalCookie(id: number): string {
  return `Id-Sucursal-Super=${id}; Id-Sucursal-Super-DisponibleYa=${id}; seleccionocp=1`;
}

/**
 * Ordered list of Cookie headers to try for a product scrape. The first entry is
 * the PRIMARY attempt (configured branch, else `undefined` = IP default); the
 * rest are the fallback-sweep branches (deduped against the primary).
 */
function buildSucursalAttempts(): Array<string | undefined> {
  if (PRIMARY_SUCURSAL !== null) {
    const rest = SUCURSAL_FALLBACKS.filter((id) => id !== PRIMARY_SUCURSAL);
    return [buildSucursalCookie(PRIMARY_SUCURSAL), ...rest.map(buildSucursalCookie)];
  }
  return [undefined, ...SUCURSAL_FALLBACKS.map(buildSucursalCookie)];
}

// Cookie used for discovery (EAN / free-text search) so the super catalog is
// visible to the search index. Uses the configured primary branch, else the
// first fallback (a large hipermercado with a broad assortment).
const DISCOVERY_COOKIE = buildSucursalCookie(
  PRIMARY_SUCURSAL ?? SUCURSAL_FALLBACKS[0] ?? DEFAULT_SUCURSAL_FALLBACKS[0]!,
);

/**
 * Errors a different sucursal might fix: a home-redirect (product_not_found),
 * a missing price, or a missing JSON-LD block can all be branch-specific.
 * Network/WAF/rate-limit failures are NOT swept (retrying other branches would
 * just hammer the same blocked egress).
 */
function isSucursalRecoverable(type: ScrapeError['type']): boolean {
  return (
    type === 'product_not_found' ||
    type === 'price_missing' ||
    type === 'selector_failed'
  );
}

// Capture the first product link of the form `/<slug>/art_<id>/`.
const PRODUCT_LINK_RE = /href=["'](\/[^"']*\/art_(\d+)\/?)["']/i;

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
  gtin?: string;
  gtin13?: string;
  category?: string;
  image?: string | string[] | { url?: string };
  brand?: { name?: string } | string;
  offers?: JsonLdOffer | JsonLdOffer[];
}

interface JsonLdPriceSpec {
  priceType?: string;
  price?: string | number;
}

interface JsonLdOffer {
  price?: string | number;
  priceCurrency?: string;
  availability?: string;
  priceSpecification?: JsonLdPriceSpec | JsonLdPriceSpec[];
}

// =============================================================================
// URL helpers
// =============================================================================

/** Strip query/hash, lowercase host; keep the path (incl. trailing slash). */
function canonicalizeUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    u.search = '';
    u.hash = '';
    u.hostname = u.hostname.toLowerCase();
    return u.toString();
  } catch {
    return rawUrl;
  }
}

/** Pull the numeric `<id>` out of `…/art_<id>/`. */
function extractProductIdFromUrl(canonicalUrl: string): string | null {
  const m = canonicalUrl.match(/\/art_(\d+)\/?($|\?|#)/);
  return m?.[1] ?? null;
}

// =============================================================================
// HTTP layer
// =============================================================================

async function fetchLaAnonimaHtml(
  url: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  cookie?: string,
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
        ...(cookie ? { Cookie: cookie } : {}),
      },
      redirect: 'follow',
      signal: controller.signal,
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new ScrapeError(
        'network_timeout',
        `La Anónima request timed out after ${timeoutMs}ms`,
        { cause: err },
      );
    }
    throw new ScrapeError(
      'network_error',
      `La Anónima request failed: ${(err as Error).message}`,
      { cause: err },
    );
  } finally {
    clearTimeout(timeoutId);
  }

  if (res.status === 404) {
    throw new ScrapeError('product_not_found', `La Anónima returned 404 for ${url}`, {
      httpStatus: 404,
    });
  }
  if (res.status === 403) {
    throw new ScrapeError(
      'network_error',
      `La Anónima returned 403 (WAF block) for ${url}`,
      { httpStatus: 403 },
    );
  }
  if (res.status === 429) {
    throw new ScrapeError('rate_limited', `La Anónima returned 429`, {
      httpStatus: 429,
    });
  }
  if (res.status >= 500) {
    throw new ScrapeError('site_server_error', `La Anónima returned ${res.status}`, {
      httpStatus: res.status,
    });
  }
  if (!res.ok) {
    throw new ScrapeError('unknown', `La Anónima returned status ${res.status}`, {
      httpStatus: res.status,
    });
  }

  // A dead/replaced article id (or one not carried in the egress IP's sucursal)
  // 302s to the homepage. Detect that here — a 200 at the site root for a
  // non-root request — and surface it as product_not_found so the re-discovery
  // healer can re-resolve the EAN to the current article. (searchByEan calls
  // this too, but it swallows all errors and returns null, so this is safe.)
  if (isHomeRedirect(url, res.url)) {
    throw new ScrapeError(
      'product_not_found',
      `La Anónima redirected ${url} to the homepage (article delisted or not in this sucursal)`,
    );
  }
  return res.text();
}

/**
 * True when a request for a real path came back at the site root, i.e. the
 * server bounced us to the homepage instead of serving the product.
 */
function isHomeRedirect(requestedUrl: string, finalUrl: string): boolean {
  try {
    const reqPath = new URL(requestedUrl).pathname.replace(/\/+$/, '');
    const finPath = new URL(finalUrl).pathname.replace(/\/+$/, '');
    return reqPath !== '' && finPath === '';
  } catch {
    return false;
  }
}

// =============================================================================
// JSON-LD extraction
// =============================================================================

const JSON_LD_RE =
  /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

/** Pull the first `Product` JSON-LD block from the page. */
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

/** Coerce a JSON-LD price (number or string) into a finite number, else NaN. */
function toNumber(v: string | number | undefined): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number(v);
  return NaN;
}

/** Normalize an EAN/gtin for comparison (digits only). */
function normalizeEan(v: string): string {
  return v.replace(/\D/g, '');
}

// =============================================================================
// EAN search (bulk product discovery)
// =============================================================================

/**
 * Find a product by EAN via the site search.
 *
 * Strategy:
 *   1. GET `/buscar/<ean>`.
 *   2. If the "No encontramos resultados" banner is present → not found. This
 *      is essential: a no-match page is otherwise full of recommended-product
 *      links that would cause false matches.
 *   3. Otherwise take the first `/<slug>/art_<id>/` link as the match.
 */
async function searchByEan(
  ean: string,
  signal?: AbortSignal,
): Promise<EanSearchResult | null> {
  const searchUrl = `${LA_ANONIMA_BASE_URL}/buscar/${encodeURIComponent(ean)}`;

  let html: string;
  try {
    html = await fetchLaAnonimaHtml(searchUrl, signal, SEARCH_TIMEOUT_MS, DISCOVERY_COOKIE);
  } catch {
    // Discovery treats any failure as "not found".
    return null;
  }

  // No-match pages render a banner + recommendation carousel; bail before we
  // mistake a recommended product for a real EAN match.
  if (NO_RESULTS_RE.test(html)) return null;

  const m = html.match(PRODUCT_LINK_RE);
  if (!m?.[1] || !m[2]) return null;

  const url = canonicalizeUrl(`${LA_ANONIMA_BASE_URL}${m[1].replace(/&amp;/g, '&')}`);
  return { url, externalId: m[2] };
}

// Capture ALL product links on a page (for name-based re-discovery candidates).
const PRODUCT_LINK_RE_GLOBAL =
  /href=["'](\/[^"']*\/art_(\d+)\/?)["']/gi;

/**
 * Free-text search returning ALL distinct product candidates (url + art id) on
 * the results page. Used by the re-discovery healer to find the replacement for
 * a delisted article when we have NO EAN to search by — the caller matches the
 * candidates against the dead product's slug (incl. a hard size check) before
 * accepting one. Returns [] on the "no results" banner or any failure.
 */
export async function searchProductCandidates(
  query: string,
  signal?: AbortSignal,
  limit = 12,
): Promise<EanSearchResult[]> {
  const searchUrl = `${LA_ANONIMA_BASE_URL}/buscar/${encodeURIComponent(query)}`;
  let html: string;
  try {
    html = await fetchLaAnonimaHtml(searchUrl, signal, SEARCH_TIMEOUT_MS, DISCOVERY_COOKIE);
  } catch {
    return [];
  }
  if (NO_RESULTS_RE.test(html)) return [];

  const out: EanSearchResult[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(PRODUCT_LINK_RE_GLOBAL)) {
    const path = m[1];
    const id = m[2];
    if (!path || !id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      url: canonicalizeUrl(`${LA_ANONIMA_BASE_URL}${path.replace(/&amp;/g, '&')}`),
      externalId: id,
    });
    if (out.length >= limit) break;
  }
  return out;
}

// =============================================================================
// Adapter
// =============================================================================

export const laAnonimaAdapter: SupermarketAdapter = {
  id: 'la-anonima',
  name: 'La Anónima',

  canonicalizeUrl,

  searchByEan,

  async resolveExternalId(canonicalUrl: string): Promise<string> {
    const id = extractProductIdFromUrl(canonicalUrl);
    if (!id) {
      throw new ScrapeError(
        'unknown',
        `La Anónima URL doesn't match /<slug>/art_<id>/: ${canonicalUrl}`,
      );
    }
    return id;
  },

  async scrape(ctx: ScrapeContext): Promise<ScrapeResult> {
    if (!ctx.externalUrl) {
      throw new ScrapeError(
        'unknown',
        `La Anónima adapter requires external_url; got null for sku=${ctx.externalId}`,
      );
    }
    ctx.logger.debug({ url: ctx.externalUrl }, 'fetching La Anónima product HTML');

    // Try the primary attempt (IP-default or configured branch); on a
    // sucursal-recoverable failure, sweep alternate super branches until one
    // stocks the product. First success wins; otherwise the last error (a real
    // product_not_found once every branch home-redirects) propagates so the
    // re-discovery healer can re-resolve the EAN.
    const attempts = buildSucursalAttempts();
    let lastError: unknown;
    for (let i = 0; i < attempts.length; i++) {
      const cookie = attempts[i];
      try {
        const html = await fetchLaAnonimaHtml(
          ctx.externalUrl,
          ctx.signal,
          REQUEST_TIMEOUT_MS,
          cookie,
        );
        const result = parseLaAnonimaHtml(html, ctx);
        if (i > 0) {
          ctx.logger.debug(
            { sucursalCookie: cookie },
            'La Anónima resolved via fallback sucursal sweep',
          );
        }
        return result;
      } catch (err) {
        if (err instanceof ScrapeError && isSucursalRecoverable(err.type)) {
          lastError = err;
          continue;
        }
        throw err; // network / WAF / rate-limit / server error — don't sweep
      }
    }
    throw lastError;
  },
};

// =============================================================================
// Pure parser — split for unit testing against saved HTML fixtures.
// =============================================================================

export function parseLaAnonimaHtml(
  html: string,
  ctx: Pick<ScrapeContext, 'externalId' | 'externalUrl'>,
): ScrapeResult {
  const product = extractProductJsonLd(html);
  if (!product) {
    throw new ScrapeError(
      'selector_failed',
      `La Anónima page has no Product JSON-LD block (sku=${ctx.externalId})`,
    );
  }

  const offer: JsonLdOffer | undefined = Array.isArray(product.offers)
    ? product.offers[0]
    : product.offers;

  // -- Price ---------------------------------------------------------------
  const price = toNumber(offer?.price);
  if (!Number.isFinite(price) || price <= 0) {
    throw new ScrapeError(
      'price_missing',
      `La Anónima JSON-LD has no usable price (sku=${ctx.externalId})`,
    );
  }
  const currency = offer?.priceCurrency || 'ARS';

  // -- List price (pre-discount): from a ListPrice priceSpecification, if it
  //    is meaningfully above the offer price.
  let listPrice: number | undefined;
  const specs = offer?.priceSpecification;
  const specList = Array.isArray(specs) ? specs : specs ? [specs] : [];
  for (const s of specList) {
    if (/ListPrice/i.test(s.priceType ?? '')) {
      const lp = toNumber(s.price);
      if (Number.isFinite(lp) && lp > price + 0.01) listPrice = lp;
    }
  }

  // -- Stock ---------------------------------------------------------------
  const availability = offer?.availability ?? '';
  const inStock = availability ? /InStock/i.test(availability) : true;

  // -- Image ---------------------------------------------------------------
  let imageUrl: string | undefined;
  if (typeof product.image === 'string') {
    imageUrl = product.image;
  } else if (Array.isArray(product.image)) {
    const first = product.image[0];
    if (typeof first === 'string') imageUrl = first;
  } else if (product.image && typeof product.image === 'object') {
    imageUrl = (product.image as { url?: string }).url;
  }

  // -- Brand (schema.org `brand.name`) -------------------------------------
  let brand: string | undefined;
  if (typeof product.brand === 'string') brand = product.brand;
  else if (product.brand && typeof product.brand === 'object') brand = product.brand.name;

  // -- Master catalog data -------------------------------------------------
  const productInfo: ProductInfo = {};
  if (product.name) productInfo.name = product.name.trim();
  if (brand) productInfo.brand = brand.trim();
  const ean = product.gtin ?? product.gtin13;
  if (ean) productInfo.ean = normalizeEan(ean);
  if (product.category) productInfo.category = product.category.trim();
  if (imageUrl) productInfo.imageUrl = imageUrl;

  const metadata: Record<string, unknown> = {};
  if (product.sku) metadata.sku = product.sku;
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
export const LA_ANONIMA_HOSTNAME = LA_ANONIMA_HOST;
