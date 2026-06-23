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

import { fetch as undiciFetch } from 'undici';
import { ScrapeError } from '../shared/errors.js';
import { getProxyDispatcher } from '../shared/proxy.js';
import { TAXONOMY_BY_EAN, type TaxonomyEntry } from '../shared/taxonomy.js';
import type {
  EanSearchResult,
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

  // Maxiconsumo's Azion edge drops non-AR/datacenter IPs, so route via the AR
  // proxy when one is configured (undefined otherwise — direct connection).
  const dispatcher = getProxyDispatcher('maxiconsumo');

  let res: Awaited<ReturnType<typeof undiciFetch>>;
  try {
    res = await undiciFetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,*/*',
        'Accept-Language': 'es-AR,es;q=0.9',
      },
      signal: controller.signal,
      ...(dispatcher ? { dispatcher } : {}),
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
// EAN discovery — name-similarity search (NO barcode confirmation possible)
// =============================================================================
//
// Maxiconsumo hides EANs entirely: its search doesn't index barcodes and the
// product page exposes none. So unlike every other adapter we CANNOT confirm a
// match by EAN. Instead we look the EAN up in the client taxonomy, search the
// site by brand, and score the result names against the taxonomy's brand +
// size + variety. To keep precision high we only return a match when exactly
// ONE candidate fits; any ambiguity yields null (better a miss than a wrong
// EAN→product mapping). Matches are meant to be reviewed before ingest.

// Only `sucursal_moreno` has a live storefront today (see file header).
const SEARCH_BASE = `https://www.${MAXICONSUMO_HOST}/sucursal_moreno/catalogsearch/result/`;
const MAX_SEARCH_PAGES = 8;

/** Strip accents + lowercase for tolerant text comparison. */
function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/** Parse "27,5" / "1.8" → number (treat comma as decimal separator). */
function toNum(s: string): number {
  return Number(s.replace(',', '.'));
}

/** A normalized size: a magnitude plus whether it's a volume or a weight. */
interface Size {
  value: number; // canonical units: millilitres (vol) or grams (wt)
  kind: 'vol' | 'wt';
}

/**
 * Normalize one "<number><unit>" token into canonical ml / g.
 * Liters→ml (×1000), kg→g (×1000); ml/cc and g/gr pass through.
 */
function normalizeUnit(value: number, unit: string): Size {
  const u = unit.toUpperCase();
  if (u === 'KG') return { value: value * 1000, kind: 'wt' };
  if (u.startsWith('L')) return { value: value * 1000, kind: 'vol' };
  if (u === 'ML' || u === 'CC') return { value, kind: 'vol' };
  return { value, kind: 'wt' }; // G / GR / GRS
}

/**
 * Derive the product size from a taxonomy `format` field. Handles bare numbers
 * (332, 360 → ml), unit-suffixed (1L, 500ML, 27.5G) and the prefix-coded
 * packaging shorthands (GAT500, DP450, BOT700 → trailing number = ml).
 */
function parseFormatSize(format: string): Size | null {
  const f = format.toUpperCase().trim();
  let m = f.match(/(\d+(?:[.,]\d+)?)\s*(ML|CC|LTS|LT|L|KG|GRS|GR|G)\b/);
  if (m?.[1] && m[2]) return normalizeUnit(toNum(m[1]), m[2]);
  // Prefix-coded packaging (e.g. GAT500, DP450, BOT700) — number = ml.
  m = f.match(/^[A-Z]+\s*(\d{2,4})$/);
  if (m?.[1]) return { value: toNum(m[1]), kind: 'vol' };
  // Bare number (aerosols / liquid cleaners are ml/cc).
  m = f.match(/^(\d+(?:[.,]\d+)?)$/);
  if (m?.[1]) return { value: toNum(m[1]), kind: 'vol' };
  return null;
}

/** Extract every "<number><unit>" size token present in a product name. */
function parseNameSizes(name: string): Size[] {
  const out: Size[] = [];
  const re = /(\d+(?:[.,]\d+)?)\s*(ML|CC|LTS|LT|L|KG|GRS|GR|G)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(name.toUpperCase())) !== null) {
    if (m[1] && m[2]) out.push(normalizeUnit(toNum(m[1]), m[2]));
  }
  return out;
}

/** Two sizes match if same kind and magnitudes are within 1% (rounding slack). */
function sizeMatches(a: Size, b: Size): boolean {
  if (a.kind !== b.kind) return false;
  const tol = Math.max(1, a.value * 0.01);
  return Math.abs(a.value - b.value) <= tol;
}

/**
 * Map a taxonomy variety code to the words that would appear in a product name.
 * Only well-known codes are listed; unknown codes return [] so the caller skips
 * variety filtering rather than guessing.
 */
const VARIETY_WORDS: Record<string, string[]> = {
  OR: ['original'],
  ORIGINAL: ['original'],
  LAV: ['lavanda'],
  LAVANDA: ['lavanda'],
  BB: ['bebe'],
  PR: ['primavera'],
  PRIMAVERA: ['primavera'],
  SPT: ['suavidad'],
  MAR: ['marina', 'marino'],
  FL: ['floral', 'flores'],
  CITRICA: ['citrica'],
  COLOR: ['color'],
  BLANCOS: ['blanco'],
};

function varietyWords(variety: string): string[] {
  return VARIETY_WORDS[variety.toUpperCase().trim()] ?? [];
}

interface SearchCard {
  url: string;
  name: string;
  externalId: string;
}

/** Parse `<a class="product-item-link" href=…>NAME</a>` cards from a results page. */
function parseMaxiSearchCards(html: string): SearchCard[] {
  const cards: SearchCard[] = [];
  const re = /class="product-item-link"\s+href="([^"]+)"[^>]*>\s*([^<]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const url = m[1];
    const name = m[2]?.trim();
    if (!url || !name) continue;
    const id = extractProductIdFromUrl(url);
    if (id) cards.push({ url, name, externalId: id });
  }
  return cards;
}

// brandQuery → all result cards, cached so each brand is searched once per run.
const brandSearchCache = new Map<string, SearchCard[]>();

/** Search Maxiconsumo for a brand, paginating until the listing clamps. */
async function searchBrand(query: string, signal: AbortSignal | undefined): Promise<SearchCard[]> {
  const cached = brandSearchCache.get(query);
  if (cached) return cached;

  const all: SearchCard[] = [];
  const seen = new Set<string>();
  let prevFirstId: string | null = null;

  for (let page = 1; page <= MAX_SEARCH_PAGES; page++) {
    const url = `${SEARCH_BASE}?q=${encodeURIComponent(query)}&p=${page}`;
    const html = await fetchMaxiconsumoHtml(url, signal);
    const cards = parseMaxiSearchCards(html);
    const firstId = cards[0]?.externalId ?? null;
    if (!firstId) break;
    // Magento clamps to the last page once you page past it (repeats it).
    if (firstId === prevFirstId) break;
    prevFirstId = firstId;
    for (const c of cards) {
      if (!seen.has(c.externalId)) {
        seen.add(c.externalId);
        all.push(c);
      }
    }
  }

  brandSearchCache.set(query, all);
  return all;
}

/**
 * Does a Maxiconsumo product name match a taxonomy entry? Requires the brand
 * and the size, and (when the entry has a known variety) a variety word too.
 */
function matchesEntry(card: SearchCard, entry: TaxonomyEntry): boolean {
  const name = normalizeText(card.name);
  if (!name.includes(normalizeText(entry.brand))) return false;

  const size = parseFormatSize(entry.format);
  if (!size || !parseNameSizes(card.name).some((s) => sizeMatches(s, size))) return false;

  const words = varietyWords(entry.variety);
  if (words.length > 0 && !words.some((w) => name.includes(w))) return false;

  return true;
}

/** Count how many taxonomy entries of the same brand a product name matches. */
function countMatchingEntries(card: SearchCard, brandNorm: string): number {
  let n = 0;
  for (const entry of TAXONOMY_BY_EAN.values()) {
    if (normalizeText(entry.brand) !== brandNorm) continue;
    if (matchesEntry(card, entry)) n++;
  }
  return n;
}

/**
 * EAN discovery via brand search + name scoring. Because Maxiconsumo exposes no
 * barcode we can't confirm matches, so we apply a strict "distinctive match"
 * rule: accept a product ONLY if it matches this entry AND no sibling EAN of
 * the same brand also matches it (i.e. the mapping is unambiguous). Anything
 * ambiguous returns null — better a miss than a wrong EAN→product mapping.
 * Matches are still NOT EAN-confirmed and should be reviewed before ingest.
 */
async function searchByEan(ean: string, signal?: AbortSignal): Promise<EanSearchResult | null> {
  const digits = ean.replace(/\D/g, '');
  const entry: TaxonomyEntry | undefined = TAXONOMY_BY_EAN.get(digits);
  if (!entry?.brand) return null;
  // Without a parseable size we can't disambiguate — skip.
  if (!parseFormatSize(entry.format)) return null;

  const brandNorm = normalizeText(entry.brand);
  const query = brandNorm.replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!query) return null;

  const cards = await searchBrand(query, signal);

  // Candidates that match this entry AND are distinctive to it (no other
  // same-brand client product also matches that Maxiconsumo product).
  const distinctive = cards.filter(
    (c) => matchesEntry(c, entry) && countMatchingEntries(c, brandNorm) === 1,
  );

  if (distinctive.length === 1) {
    return { url: distinctive[0]!.url, externalId: distinctive[0]!.externalId };
  }
  return null;
}

// =============================================================================
// Adapter
// =============================================================================

export const maxiconsumoAdapter: SupermarketAdapter = {
  id: 'maxiconsumo',
  name: 'Maxiconsumo',

  canonicalizeUrl,

  searchByEan,

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
