/**
 * Súper El Cóndor adapter (WooCommerce).
 *
 * El Cóndor (superelcondor.com.ar, Oberá - Misiones) runs WooCommerce with the
 * Porto theme. Every product page emits a schema.org `Product` JSON-LD block
 * with `name`, `sku`, `offers.price`, `availability`, and `image`. We GET the
 * page and read everything from the JSON-LD — no JS rendering, no auth.
 *
 * URL pattern: `/producto/<slug>/`  → `<slug>` is the external_id.
 *
 * NOTE — no EAN discovery: WooCommerce's `sku` here is an internal code (e.g.
 * "80417"), NOT the barcode, and the page exposes no EAN/gtin anywhere. There
 * is therefore no reliable way to map a client EAN to an El Cóndor product, so
 * this adapter intentionally omits `searchByEan`. Products are ingested by URL.
 */

import { ScrapeError } from '../shared/errors.js';
import type {
  ProductInfo,
  Promotion,
  ScrapeContext,
  ScrapeResult,
  SupermarketAdapter,
} from './types.js';

const REQUEST_TIMEOUT_MS = 20_000;
const EL_CONDOR_HOST = 'superelcondor.com.ar';

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
  image?: string | string[] | { url?: string };
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

/**
 * Strip query/hash and lowercase the host. We KEEP the trailing slash:
 * WooCommerce product permalinks are canonical with it, and removing it would
 * trigger a 301 redirect.
 */
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

/** Use the WooCommerce product slug (last path segment) as the external_id. */
function resolveExternalIdFromUrl(canonicalUrl: string): string {
  try {
    const segments = new URL(canonicalUrl).pathname.split('/').filter(Boolean);
    return segments.pop() ?? canonicalUrl;
  } catch {
    return canonicalUrl;
  }
}

// =============================================================================
// HTTP layer
// =============================================================================

async function fetchElCondorHtml(
  url: string,
  signal: AbortSignal | undefined,
): Promise<string> {
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
        Accept: 'text/html,application/xhtml+xml,*/*',
        'Accept-Language': 'es-AR,es;q=0.9',
      },
      // Follow redirects: WooCommerce normalizes the trailing slash via 301.
      redirect: 'follow',
      signal: controller.signal,
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new ScrapeError(
        'network_timeout',
        `El Cóndor request timed out after ${REQUEST_TIMEOUT_MS}ms`,
        { cause: err },
      );
    }
    throw new ScrapeError(
      'network_error',
      `El Cóndor request failed: ${(err as Error).message}`,
      { cause: err },
    );
  } finally {
    clearTimeout(timeoutId);
  }

  if (res.status === 404) {
    throw new ScrapeError('product_not_found', `El Cóndor returned 404 for ${url}`, {
      httpStatus: 404,
    });
  }
  if (res.status === 429) {
    throw new ScrapeError('rate_limited', `El Cóndor returned 429`, { httpStatus: 429 });
  }
  if (res.status >= 500) {
    throw new ScrapeError('site_server_error', `El Cóndor returned ${res.status}`, {
      httpStatus: res.status,
    });
  }
  if (!res.ok) {
    throw new ScrapeError('unknown', `El Cóndor returned status ${res.status}`, {
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

/** Pull the first Product JSON-LD block out of the page. */
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

// =============================================================================
// Adapter
// =============================================================================

export const elCondorAdapter: SupermarketAdapter = {
  id: 'el-condor',
  name: 'Súper El Cóndor',

  canonicalizeUrl,

  async resolveExternalId(canonicalUrl: string): Promise<string> {
    return resolveExternalIdFromUrl(canonicalUrl);
  },

  async scrape(ctx: ScrapeContext): Promise<ScrapeResult> {
    if (!ctx.externalUrl) {
      throw new ScrapeError(
        'unknown',
        `El Cóndor adapter requires external_url; got null for sku=${ctx.externalId}`,
      );
    }
    ctx.logger.debug({ url: ctx.externalUrl }, 'fetching El Cóndor product HTML');
    const html = await fetchElCondorHtml(ctx.externalUrl, ctx.signal);
    return parseElCondorHtml(html, ctx);
  },
};

// =============================================================================
// Pure parser — split for unit testing against saved HTML fixtures.
// =============================================================================

export function parseElCondorHtml(
  html: string,
  ctx: Pick<ScrapeContext, 'externalId' | 'logger'>,
): ScrapeResult {
  const product = extractProductJsonLd(html);
  if (!product) {
    throw new ScrapeError(
      'selector_failed',
      `El Cóndor page has no Product JSON-LD block (sku=${ctx.externalId})`,
    );
  }

  const offer: JsonLdOffer | undefined = Array.isArray(product.offers)
    ? product.offers[0]
    : product.offers;

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
      `El Cóndor JSON-LD has no usable price (sku=${ctx.externalId})`,
    );
  }
  const currency = offer?.priceCurrency || 'ARS';

  const availability = offer?.availability ?? '';
  const inStock = availability ? /InStock/i.test(availability) : true;

  let imageUrl: string | undefined;
  if (typeof product.image === 'string') {
    imageUrl = product.image;
  } else if (Array.isArray(product.image)) {
    const first = product.image[0];
    if (typeof first === 'string') imageUrl = first;
  } else if (product.image && typeof product.image === 'object') {
    imageUrl = (product.image as { url?: string }).url;
  }

  const productInfo: ProductInfo = {};
  if (product.name) productInfo.name = product.name.trim();
  if (imageUrl) productInfo.imageUrl = imageUrl;
  if (product.sku) productInfo.metadata = { wooSku: product.sku };

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
export const EL_CONDOR_HOSTNAME = EL_CONDOR_HOST;
