/**
 * Maxiconsumo adapter (Magento 2).
 *
 * Strategy: single SSR HTML fetch + regex extraction.
 *
 *   - No JSON-LD on this site; instead the page has rich schema.org microdata
 *     (`itemprop="price"`, `itemprop="priceCurrency"`, `itemprop="sku"`,
 *     `itemprop="name"`) plus an inline GA4 `dataLayer` JSON with brand and
 *     full category breadcrumb.
 *   - The Magento REST API (`/rest/V1/...`) is closed (403). HTML is the only
 *     viable path for guests.
 *   - Branch (sucursal) is purely a path prefix. Today only `sucursal_moreno`
 *     is online — other physical branches don't have a storefront. Prices the
 *     site shows are wholesale ("comerciante") prices, no login needed.
 *
 * URL pattern: `/sucursal_<branch>/<category>/<slug>-<id>.html`
 *   → external_id is the trailing numeric `<id>` (== Maxiconsumo's public SKU).
 *   → branch defaults to `sucursal_moreno`; if a future URL ships another
 *     branch we just use whatever's in the URL.
 *
 * Caveat: EAN/GTIN is NOT exposed anywhere in the public HTML, so master
 * `products` rows for Maxiconsumo can't dedupe by EAN.
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
const MAXICONSUMO_HOST = 'maxiconsumo.com';

const USER_AGENT =
  'Mozilla/5.0 (compatible; PriceScraperBot/1.0; +https://example.com/bot)';

// =============================================================================
// URL helpers
// =============================================================================

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

/** Pull the trailing `<id>` out of `…/<slug>-<id>.html`. */
function extractProductIdFromUrl(canonicalUrl: string): string | null {
  try {
    const path = new URL(canonicalUrl).pathname;
    const m = path.match(/-(\d+)\.html$/);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

// =============================================================================
// HTTP layer
// =============================================================================

async function fetchMaxiconsumoHtml(
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
      signal: controller.signal,
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new ScrapeError(
        'network_timeout',
        `Maxiconsumo request timed out after ${REQUEST_TIMEOUT_MS}ms`,
        { cause: err },
      );
    }
    throw new ScrapeError(
      'network_error',
      `Maxiconsumo request failed: ${(err as Error).message}`,
      { cause: err },
    );
  } finally {
    clearTimeout(timeoutId);
  }

  if (res.status === 404) {
    throw new ScrapeError(
      'product_not_found',
      `Maxiconsumo returned 404 for ${url}`,
      { httpStatus: 404 },
    );
  }
  if (res.status === 429) {
    throw new ScrapeError('rate_limited', `Maxiconsumo returned 429`, {
      httpStatus: 429,
    });
  }
  if (res.status >= 500) {
    throw new ScrapeError(
      'site_server_error',
      `Maxiconsumo returned ${res.status}`,
      { httpStatus: res.status },
    );
  }
  if (!res.ok) {
    throw new ScrapeError(
      'unknown',
      `Maxiconsumo returned unexpected status ${res.status}`,
      { httpStatus: res.status },
    );
  }
  return res.text();
}

// =============================================================================
// HTML extraction helpers
// =============================================================================

/** Extract the value of an `itemprop="<name>"` attribute (`content="…"`). */
function extractItempropContent(html: string, name: string): string | undefined {
  const re = new RegExp(
    `itemprop=["']${name}["'][^>]*\\bcontent=["']([^"']+)["']`,
    'i',
  );
  return html.match(re)?.[1];
}

/** Extract the inner text of `<X itemprop="<name>">…</X>`. */
function extractItempropText(html: string, name: string): string | undefined {
  // Loose but reliable: find the opening tag with itemprop, then capture up
  // to the next `<`. Page is too varied for a strict element match.
  const re = new RegExp(
    `itemprop=["']${name}["'][^>]*>\\s*([^<]+?)\\s*<`,
    'i',
  );
  return html.match(re)?.[1]?.trim();
}

/** Extract `<meta property="og:<name>" content="…">`. */
function extractOgMeta(html: string, name: string): string | undefined {
  const re = new RegExp(
    `<meta\\s+property=["']og:${name}["'][^>]*\\bcontent=["']([^"']+)["']`,
    'i',
  );
  return html.match(re)?.[1];
}

interface DataLayerItem {
  item_id?: string;
  item_name?: string;
  item_brand?: string;
  item_category?: string;
  item_category2?: string;
  item_category3?: string;
  item_category4?: string;
  item_category5?: string;
  price?: number;
  package?: string;
}

/**
 * The Magento theme inlines a GA4 push as `let items = {…};`. It carries the
 * cleanest structured data on the page (brand + category breadcrumb).
 * Returns undefined if the block isn't present (some product types skip it).
 */
function extractDataLayerItem(html: string): DataLayerItem | undefined {
  // Match `items = { ... };` where `{` is balanced one level (quick-and-dirty).
  const m = html.match(/items\s*=\s*(\{[^;]*?\})\s*;/);
  if (!m?.[1]) return undefined;
  try {
    return JSON.parse(m[1]) as DataLayerItem;
  } catch {
    return undefined;
  }
}

/**
 * Inspect the `<div class="stock available|unavailable">` marker that
 * Magento's default theme renders for the main product summary block.
 */
function extractStock(html: string): boolean {
  const m = html.match(/class=["']stock\s+(available|unavailable)["']/i);
  if (m?.[1] === 'available') return true;
  if (m?.[1] === 'unavailable') return false;
  // Fallback: page that doesn't render the canonical pill is treated as in-stock.
  return true;
}

/** Branch prefix we found in the URL (`sucursal_moreno`). */
function extractBranchFromUrl(canonicalUrl: string): string | undefined {
  try {
    const path = new URL(canonicalUrl).pathname;
    const m = path.match(/^\/(sucursal_[a-z0-9_]+)\//i);
    return m?.[1]?.toLowerCase();
  } catch {
    return undefined;
  }
}

// =============================================================================
// Adapter
// =============================================================================

export const maxiconsumoAdapter: SupermarketAdapter = {
  id: 'maxiconsumo',
  name: 'Maxiconsumo',

  canonicalizeUrl,

  async resolveExternalId(canonicalUrl: string): Promise<string> {
    const id = extractProductIdFromUrl(canonicalUrl);
    if (!id) {
      throw new ScrapeError(
        'unknown',
        `Maxiconsumo URL doesn't match …/<slug>-<id>.html: ${canonicalUrl}`,
      );
    }
    return id;
  },

  async scrape(ctx: ScrapeContext): Promise<ScrapeResult> {
    if (!ctx.externalUrl) {
      throw new ScrapeError(
        'unknown',
        `Maxiconsumo adapter requires external_url; got null for sku=${ctx.externalId}`,
      );
    }
    ctx.logger.debug({ url: ctx.externalUrl }, 'fetching Maxiconsumo HTML');
    const html = await fetchMaxiconsumoHtml(ctx.externalUrl, ctx.signal);
    return parseMaxiconsumoHtml(html, ctx);
  },
};

// =============================================================================
// Pure parser — split for unit testing against saved HTML fixtures.
// =============================================================================

export function parseMaxiconsumoHtml(
  html: string,
  ctx: Pick<ScrapeContext, 'externalId' | 'externalUrl'>,
): ScrapeResult {
  // -- Price ---------------------------------------------------------------
  // Prefer microdata; fall back to the OG meta tag (same value, different
  // formatting) so we still get a price if Magento ever drops the microdata.
  const priceRaw =
    extractItempropContent(html, 'price') ??
    html.match(
      /<meta\s+property=["']product:price:amount["'][^>]*\bcontent=["']([^"']+)["']/i,
    )?.[1];
  const price = priceRaw !== undefined ? Number(priceRaw) : NaN;
  if (!Number.isFinite(price) || price <= 0) {
    throw new ScrapeError(
      'price_missing',
      `Maxiconsumo page has no usable price (sku=${ctx.externalId})`,
    );
  }

  const currency =
    extractItempropContent(html, 'priceCurrency') ??
    html.match(
      /<meta\s+property=["']product:price:currency["'][^>]*\bcontent=["']([^"']+)["']/i,
    )?.[1] ??
    'ARS';

  // -- Stock ---------------------------------------------------------------
  const inStock = extractStock(html);

  // -- Catalog data --------------------------------------------------------
  const dl = extractDataLayerItem(html);
  const productInfo: ProductInfo = {};

  const name = dl?.item_name ?? extractItempropText(html, 'name');
  if (name) productInfo.name = name.trim();
  const brand = dl?.item_brand;
  if (brand) productInfo.brand = brand.trim();
  // Use the deepest non-empty category from the breadcrumb chain.
  const cat =
    dl?.item_category5 ||
    dl?.item_category4 ||
    dl?.item_category3 ||
    dl?.item_category2 ||
    dl?.item_category;
  if (cat) productInfo.category = cat.trim();
  const imageUrl = extractOgMeta(html, 'image');
  if (imageUrl) productInfo.imageUrl = imageUrl;

  const metadata: Record<string, unknown> = {};
  if (dl?.item_id) metadata.publicSku = dl.item_id;
  if (dl?.package) metadata.packageOptions = dl.package;
  const branch = ctx.externalUrl ? extractBranchFromUrl(ctx.externalUrl) : undefined;
  if (branch) metadata.branch = branch;
  if (Object.keys(metadata).length > 0) productInfo.metadata = metadata;

  return {
    price,
    inStock,
    currency,
    tierUsed: 'html',
    promotions: [] as Promotion[],
    productInfo,
    rawData: {
      ...(dl ? { dataLayer: dl } : {}),
      // Don't ship raw HTML in `rawData` — too big and not useful to forensics.
    },
  };
}

export const MAXICONSUMO_HOSTNAME = MAXICONSUMO_HOST;
