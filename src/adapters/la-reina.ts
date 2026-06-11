/**
 * La Reina Online adapter (bespoke ASP storefront).
 *
 * La Reina (lareinaonline.com.ar, Rosario - Santa Fe) is a classic server-
 * rendered ASP site. Product pages are addressed directly by EAN:
 *
 *   /productosdet.asp?Pr=<EAN>&P=1&producto=<slug>
 *
 * The `Pr` query param IS the product's EAN, which makes EAN discovery trivial:
 * we build the URL from the barcode and verify the product renders. There is no
 * JSON/JSON-LD — we parse the server HTML:
 *   - price: `<div class="TotPreTik">$4.006,<b>00</b></div>` (split across nodes)
 *   - name:  `<h1 class="seo-title">...</h1>`
 * A non-existent EAN renders the page WITHOUT a price/title block, which we use
 * as the "not found" signal.
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
const LA_REINA_HOST = 'lareinaonline.com.ar';
const LA_REINA_BASE_URL = 'https://www.lareinaonline.com.ar';

// La Reina's ASP front-end / WAF serves an empty page to non-browser UAs, so
// we present a realistic Chrome UA (a plain bot UA yields no price block).
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// =============================================================================
// URL helpers
// =============================================================================

/** Extract the `Pr` (EAN) query param from any La Reina product URL. */
function extractPrParam(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).searchParams.get('Pr');
  } catch {
    return null;
  }
}

/**
 * Canonical form keeps ONLY the `Pr` (EAN) param — it alone identifies the
 * product. The `P` (pagination) and `producto` (slug) params are decorative.
 */
function canonicalizeUrl(rawUrl: string): string {
  const ean = extractPrParam(rawUrl);
  if (ean) return buildProductUrl(ean);
  return rawUrl;
}

/** Build the canonical product URL for a given EAN. */
function buildProductUrl(ean: string): string {
  return `${LA_REINA_BASE_URL}/productosdet.asp?Pr=${encodeURIComponent(ean)}`;
}

/** The external_id is the EAN carried in the `Pr` param. */
function resolveExternalIdFromUrl(canonicalUrl: string): string {
  const ean = extractPrParam(canonicalUrl);
  if (ean) return ean;
  try {
    return new URL(canonicalUrl).pathname;
  } catch {
    return canonicalUrl;
  }
}

// =============================================================================
// HTML parsing
// =============================================================================

/** Remove tags and collapse whitespace from an HTML fragment. */
function stripTags(fragment: string): string {
  return fragment
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse an Argentine-formatted price ("$ 4.006,00" → 4006.00). Dots are
 * thousands separators, comma is the decimal separator.
 */
function parseArPrice(raw: string): number {
  const digits = raw.replace(/[^\d.,]/g, '').replace(/\./g, '').replace(',', '.');
  const n = Number(digits);
  return Number.isFinite(n) ? n : NaN;
}

// Price lives in `<div class='TotPreTik'>` (digits split across <b> tags).
// NOTE: the raw server HTML uses SINGLE quotes on attributes, so the class
// matchers must accept either quote style (the browser DOM normalizes to
// double quotes, which is misleading when copying markup from devtools).
const TOT_PRE_TIK_RE =
  /<div[^>]*class=['"][^'"]*\bTotPreTik\b[^'"]*['"][^>]*>([\s\S]*?)<\/div>/i;

/** Product title lives in `<h1 class='seo-title'>`. */
const SEO_TITLE_RE =
  /<h1[^>]*class=['"][^'"]*\bseo-title\b[^'"]*['"][^>]*>([\s\S]*?)<\/h1>/i;

interface ParsedProduct {
  name: string | undefined;
  price: number;
}

/**
 * Extract `{name, price}` from a product page, or `null` when the page has no
 * product (e.g. an unknown EAN renders the chrome without a price block).
 */
function parseProduct(html: string): ParsedProduct | null {
  const priceMatch = html.match(TOT_PRE_TIK_RE);
  if (!priceMatch?.[1]) return null;
  const price = parseArPrice(stripTags(priceMatch[1]));
  if (!Number.isFinite(price) || price <= 0) return null;

  const nameMatch = html.match(SEO_TITLE_RE);
  const name = nameMatch?.[1] ? stripTags(nameMatch[1]) : undefined;

  return { name, price };
}

// =============================================================================
// HTTP layer
// =============================================================================

async function fetchLaReinaHtml(
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
      redirect: 'follow',
      signal: controller.signal,
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new ScrapeError(
        'network_timeout',
        `La Reina request timed out after ${timeoutMs}ms`,
        { cause: err },
      );
    }
    throw new ScrapeError(
      'network_error',
      `La Reina request failed: ${(err as Error).message}`,
      { cause: err },
    );
  } finally {
    clearTimeout(timeoutId);
  }

  if (res.status === 404) {
    throw new ScrapeError('product_not_found', `La Reina returned 404 for ${url}`, {
      httpStatus: 404,
    });
  }
  if (res.status === 429) {
    throw new ScrapeError('rate_limited', `La Reina returned 429`, { httpStatus: 429 });
  }
  if (res.status >= 500) {
    throw new ScrapeError('site_server_error', `La Reina returned ${res.status}`, {
      httpStatus: res.status,
    });
  }
  if (!res.ok) {
    throw new ScrapeError('unknown', `La Reina returned status ${res.status}`, {
      httpStatus: res.status,
    });
  }
  return res.text();
}

// =============================================================================
// EAN search (bulk product discovery)
//
// `Pr=<EAN>` addresses the product directly, so "search" is just "fetch the
// product page and check it renders a price".
// =============================================================================

async function searchByEan(
  ean: string,
  signal?: AbortSignal,
): Promise<EanSearchResult | null> {
  const url = buildProductUrl(ean);

  // NOTE: we intentionally let fetch/HTTP errors propagate so the discover
  // script records them in its Errors summary. Returning null is reserved for
  // a genuine "product not on site" (a 200 page with no price block). A
  // not-found EAN at La Reina renders 200 (no 404), so this stays clean.
  const html = await fetchLaReinaHtml(url, signal, SEARCH_TIMEOUT_MS);

  const parsed = parseProduct(html);
  if (!parsed) return null;

  return { url, externalId: ean };
}

// =============================================================================
// Adapter
// =============================================================================

export const laReinaAdapter: SupermarketAdapter = {
  id: 'la-reina',
  name: 'La Reina Online',

  canonicalizeUrl,

  searchByEan,

  async resolveExternalId(canonicalUrl: string): Promise<string> {
    return resolveExternalIdFromUrl(canonicalUrl);
  },

  async scrape(ctx: ScrapeContext): Promise<ScrapeResult> {
    if (!ctx.externalUrl) {
      throw new ScrapeError(
        'unknown',
        `La Reina adapter requires external_url; got null for sku=${ctx.externalId}`,
      );
    }
    ctx.logger.debug({ url: ctx.externalUrl }, 'fetching La Reina product HTML');
    const html = await fetchLaReinaHtml(ctx.externalUrl, ctx.signal, REQUEST_TIMEOUT_MS);
    return parseLaReinaHtml(html, ctx);
  },
};

// =============================================================================
// Pure parser — split for unit testing against saved HTML fixtures.
// =============================================================================

export function parseLaReinaHtml(
  html: string,
  ctx: Pick<ScrapeContext, 'externalId' | 'externalUrl' | 'logger'>,
): ScrapeResult {
  const parsed = parseProduct(html);
  if (!parsed) {
    throw new ScrapeError(
      'price_missing',
      `La Reina page has no price for sku=${ctx.externalId} (product may not exist)`,
    );
  }

  const productInfo: ProductInfo = {};
  if (parsed.name) productInfo.name = parsed.name;
  // The external_id is the EAN; surface it as catalog data too.
  const ean = ctx.externalUrl ? extractPrParam(ctx.externalUrl) : null;
  if (ean) productInfo.ean = ean;

  return {
    price: parsed.price,
    inStock: true,
    currency: 'ARS',
    tierUsed: 'html',
    promotions: [] as Promotion[],
    productInfo,
    rawData: {},
  };
}

/** Hostname helper used by `detectSupermarket`. Exported for tests. */
export const LA_REINA_HOSTNAME = LA_REINA_HOST;
