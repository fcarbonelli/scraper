/**
 * La Gallega adapter (lagallega.com.ar — bespoke "ASP" storefront, Rosario/SF).
 *
 * Same engine family as La Reina: classic ASP pages with `productosdet.asp` for
 * detail and `productosnl.asp` for listing/search. Everything is server-rendered
 * HTML — no JSON API, no JSON-LD.
 *
 * URL pattern: `/productosdet.asp?Pr=<internalId>`  → `<Pr>` (an internal product
 * id, NOT the barcode) is the external_id. The detail page exposes the barcode
 * and name inside an image tile's `alt`, and the price in a `DetallPrec` block:
 *
 *   <div ... data-image="Fotos/Articulos/10355.jpg"
 *        alt="7793253003425 - quitamanchas ayudin x 700 ml. blanco supremo"></div>
 *   <div class="DetallPrec"><div class='izq'>$5.207,24</div></div>
 *
 * EAN DISCOVERY — La Gallega's search (`productosnl.asp`, hidden field `TM=Bus`)
 * indexes product NAMES, not barcodes: searching an EAN returns nothing. But
 * every search-result card carries its barcode in the image `alt`, so we can
 * still resolve a client EAN exactly:
 *
 *   1. Look up the EAN in the client taxonomy to get its brand.
 *   2. Search that brand, paginate (`&pg=N`) until the listing clamps (the last
 *      page repeats), collecting every result's EAN → Pr.
 *   3. Return the card whose barcode equals the requested EAN.
 *
 * This is a name-similarity search (by brand) made precise by confirming the
 * barcode — so there are no false matches. Per-brand crawls are cached so the
 * ~211 client EANs only trigger ~one search per brand.
 */

import { ScrapeError } from '../shared/errors.js';
import { TAXONOMY_BY_EAN } from '../shared/taxonomy.js';
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
const MAX_SEARCH_PAGES = 25;

const GALLEGA_HOST = 'lagallega.com.ar';
const BASE_URL = 'https://www.lagallega.com.ar';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// =============================================================================
// Networking (light cookie jar — the ASP search is session-stateful)
// =============================================================================

const cookieJar = new Map<string, string>();

function describeFetchError(err: unknown): string {
  const e = err as { message?: string; cause?: unknown };
  const cause = e.cause as { code?: string; message?: string } | undefined;
  const detail = cause?.code ?? cause?.message;
  return detail ? `${e.message ?? 'fetch failed'} (${detail})` : e.message ?? String(err);
}

function storeCookies(res: Response): void {
  const list = (res.headers as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  for (const raw of list) {
    const pair = raw.split(';', 1)[0] ?? '';
    const eq = pair.indexOf('=');
    if (eq > 0) cookieJar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

function cookieHeader(): string {
  return Array.from(cookieJar, ([k, v]) => `${k}=${v}`).join('; ');
}

/** GET an HTML page, mapping transport/HTTP failures to typed ScrapeErrors. */
async function fetchGallega(
  path: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'es-AR,es;q=0.9',
    };
    const ck = cookieHeader();
    if (ck) headers.Cookie = ck;

    const res = await fetch(`${BASE_URL}${path}`, {
      headers,
      redirect: 'follow',
      signal: controller.signal,
    });
    storeCookies(res);

    if (res.status === 429) {
      throw new ScrapeError('rate_limited', 'La Gallega rate-limited the request', { httpStatus: 429 });
    }
    if (res.status >= 500) {
      throw new ScrapeError('site_server_error', `La Gallega returned HTTP ${res.status}`, {
        httpStatus: res.status,
      });
    }
    if (res.status === 404) {
      throw new ScrapeError('product_not_found', 'La Gallega product not found (404)', { httpStatus: 404 });
    }
    return res.text();
  } catch (err: unknown) {
    if (err instanceof ScrapeError) throw err;
    if ((err as { name?: string }).name === 'AbortError') {
      throw new ScrapeError('network_timeout', `La Gallega request timed out after ${timeoutMs}ms`, {
        cause: err,
      });
    }
    throw new ScrapeError('network_error', `La Gallega request failed: ${describeFetchError(err)}`, {
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

/** Parse an es-AR money string ("$5.207,24") into a number (5207.24). */
function parseArs(raw: string): number {
  const cleaned = raw.replace(/[^\d.,]/g, '').replace(/\./g, '').replace(',', '.');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

// Detail page: the image tile carries "<EAN> - <name>" in its alt.
const DETAIL_TILE_RE = /data-image="Fotos\/Articulos\/\d+\.[a-z]+"\s*alt="(\d{8,14})\s*-\s*([^"]*)"/i;
const DETAIL_PRICE_RE = /class=["']DetallPrec["'][\s\S]{0,120}?\$\s*([\d.]+,\d{2})/i;
const OUT_OF_STOCK_RE = /sin\s*stock|no\s+disponible|agotado/i;

/** Build a ScrapeResult from a productosdet.asp page. */
export function parseLaGallegaHtml(
  html: string,
  ctx: Pick<ScrapeContext, 'externalId' | 'externalUrl'>,
): ScrapeResult {
  const priceM = html.match(DETAIL_PRICE_RE);
  const price = priceM?.[1] ? parseArs(priceM[1]) : NaN;
  if (!Number.isFinite(price) || price <= 0) {
    throw new ScrapeError('price_missing', 'La Gallega product has no usable price');
  }

  const inStock = !OUT_OF_STOCK_RE.test(html);
  const productInfo: ProductInfo = {};
  const tileM = html.match(DETAIL_TILE_RE);
  if (tileM?.[1]) {
    productInfo.ean = tileM[1];
    productInfo.imageUrl = `${BASE_URL}/Fotos/Articulos/${ctx.externalId}.jpg`;
  }
  if (tileM?.[2]) productInfo.name = tileM[2].trim();

  return {
    price,
    inStock,
    currency: 'ARS',
    tierUsed: 'html',
    promotions: [] as Promotion[],
    productInfo,
    rawData: { externalId: ctx.externalId },
  };
}

/** Extract { ean → Pr } from a productosnl.asp results page. */
function parseSearchCards(html: string): Array<{ pr: string; ean: string }> {
  const cards: Array<{ pr: string; ean: string }> = [];
  const re = /productosdet\.asp\?Pr=(\d+)[\s\S]{0,300}?<img[^>]*alt="(\d{8,14})\s*-/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const pr = m[1];
    const ean = m[2];
    if (pr && ean) cards.push({ pr, ean });
  }
  return cards;
}

// =============================================================================
// URL helpers
// =============================================================================

/** Read the `Pr` internal id out of a productosdet.asp URL. */
function prFromUrl(url: string): string | null {
  try {
    return new URL(url).searchParams.get('Pr');
  } catch {
    return null;
  }
}

function canonicalizeUrl(raw: string): string {
  const pr = prFromUrl(raw);
  if (pr) return `${BASE_URL}/productosdet.asp?Pr=${pr}`;
  try {
    const u = new URL(raw);
    u.protocol = 'https:';
    u.host = 'www.lagallega.com.ar';
    return u.toString();
  } catch {
    return raw;
  }
}

async function resolveExternalId(canonicalUrl: string): Promise<string> {
  const pr = prFromUrl(canonicalUrl);
  if (!pr) {
    throw new ScrapeError('parse_failed', `La Gallega URL has no Pr id: ${canonicalUrl}`);
  }
  return pr;
}

// =============================================================================
// Brand-search crawl (name-similarity discovery, EAN-confirmed)
// =============================================================================

/** Normalize a brand into a search query: strip accents, lowercase, trim. */
function toQuery(brand: string): string {
  return brand
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    // Drop the chars La Gallega's search rejects (@$'#&<>"*[]^?%).
    .replace(/[@$'#&<>"*[\]^?%]/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** query → (ean → Pr), cached so each brand is crawled at most once per run. */
const brandIndexCache = new Map<string, Map<string, string>>();

/**
 * Search a query (a brand), paginate until the listing clamps to its last page,
 * and return a map of every result's barcode → internal Pr id.
 */
async function crawlQuery(query: string, signal: AbortSignal | undefined): Promise<Map<string, string>> {
  const cached = brandIndexCache.get(query);
  if (cached) return cached;

  const index = new Map<string, string>();
  let prevFirstEan: string | null = null;

  for (let pg = 1; pg <= MAX_SEARCH_PAGES; pg++) {
    const html = await fetchGallega(
      `/productosnl.asp?pg=${pg}&nl=&TM=Bus&cpoB=${encodeURIComponent(query)}`,
      signal,
      SEARCH_TIMEOUT_MS,
    );
    const cards = parseSearchCards(html);
    const firstEan = cards[0]?.ean;
    if (!firstEan) break;
    // The listing clamps to the last page once we go past it (it repeats).
    if (firstEan === prevFirstEan) break;
    prevFirstEan = firstEan;
    for (const c of cards) if (!index.has(c.ean)) index.set(c.ean, c.pr);
  }

  brandIndexCache.set(query, index);
  return index;
}

// =============================================================================
// Adapter methods
// =============================================================================

async function scrape(ctx: ScrapeContext): Promise<ScrapeResult> {
  const pr = ctx.externalId?.trim();
  if (!pr) {
    throw new ScrapeError('product_not_found', 'La Gallega scrape called without an external_id');
  }
  const html = await fetchGallega(`/productosdet.asp?Pr=${encodeURIComponent(pr)}`, ctx.signal, REQUEST_TIMEOUT_MS);
  return parseLaGallegaHtml(html, ctx);
}

async function probe(ctx: ScrapeContext): Promise<ProductInfo> {
  try {
    const result = await scrape(ctx);
    return result.productInfo ?? {};
  } catch {
    return {};
  }
}

/**
 * EAN discovery via brand search + exact barcode confirmation. La Gallega's
 * search can't match a raw EAN, so we search the product's brand (from the
 * client taxonomy) and look for the exact barcode among the results.
 */
async function searchByEan(ean: string, signal?: AbortSignal): Promise<EanSearchResult | null> {
  const digits = ean.replace(/\D/g, '');
  if (!digits) return null;

  // We need a name to search; the brand comes from the client taxonomy.
  const taxonomy = TAXONOMY_BY_EAN.get(digits);
  const query = taxonomy?.brand ? toQuery(taxonomy.brand) : '';
  if (!query) return null;

  const index = await crawlQuery(query, signal);
  const pr = index.get(digits);
  if (!pr) return null;

  return { url: `${BASE_URL}/productosdet.asp?Pr=${pr}`, externalId: pr };
}

export const laGallegaAdapter: SupermarketAdapter = {
  id: 'la-gallega',
  name: 'La Gallega',
  canonicalizeUrl,
  resolveExternalId,
  scrape,
  probe,
  searchByEan,
};

export { GALLEGA_HOST };
