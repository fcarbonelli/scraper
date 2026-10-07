/**
 * Super Mami adapter (Grupo Dinosaurio / "Dinoonline").
 *
 * Super Mami runs Oracle Commerce / Endeca — the same engine as Coto, but a
 * different storefront ("Neticel" theme). Like Coto, appending `?format=json`
 * to any product URL returns the JSON the site renders from.
 *
 * Key differences from Coto:
 *   - EAN attribute is `product.ean` (Coto uses `product.eanPrincipal`).
 *   - Price is a plain `sku.activePrice` number (Coto uses a JSON `sku.dtoPrice`).
 *   - Product pages live at `/super/producto/<slug>/_/A-<id>` (Coto: `/_/R-<id>`).
 *
 * Sale / regular price (updated 2026-10): `sku.activePrice` and the HTML price
 * block disagree in BOTH directions (JSON lags a new sale, or JSON lags a
 * sale ending), and the "antes" line is not always rendered. The HTML big
 * figure is what a customer sees on the PDP, so that is `price`. The regular
 * price is the highest of the "antes" line (when present) and the JSON
 * `activePrice`, when that is above the HTML figure. JSON-only is the
 * fallback if the HTML fetch fails. The export then derives Precio_Regular
 * (list) and Precio_c_Oferta_1 (active) from `list_price`/`price`.
 *
 * URL pattern: `https://www.supermami.com.ar/super/producto/<slug>/_/A-<id>`
 *   → `<id>` (e.g. "2811471-2811471-s") is the external_id. Endeca resolves the
 *     page by this id regardless of the (decorative) slug, so EAN discovery can
 *     build URLs with a slug derived from the product name.
 */

import { fetch as undiciFetch } from 'undici';
import { ScrapeError } from '../shared/errors.js';
import { getProxyDispatcher } from '../shared/proxy.js';
import type {
  EanSearchResult,
  Promotion,
  ScrapeContext,
  ScrapeResult,
  SupermarketAdapter,
} from './types.js';

const REQUEST_TIMEOUT_MS = 15_000;
const SEARCH_TIMEOUT_MS = 15_000;

/** Realistic UA — Dinoonline's WAF 403s the default Node fetch agent. */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Public base URL for building canonical product URLs during EAN discovery. */
const MAMI_BASE_URL = 'https://www.supermami.com.ar';

type Attrs = Record<string, unknown>;

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

/** Extract the `A-<id>` segment (the stable Endeca record id) from a URL. */
function resolveExternalIdFromUrl(canonicalUrl: string): string {
  const match = canonicalUrl.match(/\/_\/A-([A-Za-z0-9-]+)/);
  if (match?.[1]) return match[1];
  try {
    return new URL(canonicalUrl).pathname;
  } catch {
    return canonicalUrl;
  }
}

/** Append `?format=json` so the site returns its JSON payload. */
function toJsonUrl(canonicalUrl: string): string {
  try {
    const u = new URL(canonicalUrl);
    u.searchParams.set('format', 'json');
    return u.toString();
  } catch {
    return canonicalUrl.includes('?')
      ? `${canonicalUrl}&format=json`
      : `${canonicalUrl}?format=json`;
  }
}

/** Build a URL-safe slug from a product name (decorative — Endeca uses the id). */
function slugify(name: string): string {
  return (
    name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'producto'
  );
}

// =============================================================================
// Attribute getters (Endeca attributes are arrays of strings)
// =============================================================================

function attrStr(attrs: Attrs, key: string): string | undefined {
  const v = attrs[key];
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  if (typeof v === 'string') return v;
  return undefined;
}

function attrNum(attrs: Attrs, key: string): number | undefined {
  const s = attrStr(attrs, key);
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/** Prefix protocol-relative image URLs (`//host/...`) with https. */
function absoluteImage(url: string | undefined): string | undefined {
  if (!url) return undefined;
  return url.startsWith('//') ? `https:${url}` : url;
}

// =============================================================================
// Recursive Endeca record finders
// =============================================================================

/**
 * Find the `attributes` of the first record that carries a price
 * (`sku.activePrice`). On a product-detail page this is the product itself;
 * header/footer content blocks have no such attribute.
 */
function findPricedAttributes(node: unknown): Attrs | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findPricedAttributes(item);
      if (found) return found;
    }
    return null;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    const attrs = obj.attributes;
    if (attrs && typeof attrs === 'object' && 'sku.activePrice' in attrs) {
      return attrs as Attrs;
    }
    for (const value of Object.values(obj)) {
      const found = findPricedAttributes(value);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Find the first record NODE whose `product.ean` matches `ean` and that exposes
 * a `detailsAction.recordState` pointing at the `/_/A-<id>` product page.
 *
 * Matching on the EAN (not just the first record) avoids mapping the client EAN
 * to an unrelated product from a recommendation carousel.
 */
function findRecordNodeByEan(
  node: unknown,
  ean: string,
): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findRecordNodeByEan(item, ean);
      if (found) return found;
    }
    return null;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    const attrs = obj.attributes as Attrs | undefined;
    const recordState = (
      obj.detailsAction as { recordState?: unknown } | undefined
    )?.recordState;
    if (
      attrs &&
      typeof attrs === 'object' &&
      String((attrs['product.ean'] as unknown[] | undefined)?.[0]) === ean &&
      typeof recordState === 'string' &&
      recordState.includes('/_/A-')
    ) {
      return obj;
    }
    for (const value of Object.values(obj)) {
      const found = findRecordNodeByEan(value, ean);
      if (found) return found;
    }
  }
  return null;
}

// =============================================================================
// HTTP layer
// =============================================================================

/**
 * Undici surfaces network failures as a generic `TypeError: fetch failed` and
 * stashes the real reason (ECONNRESET, ETIMEDOUT, ENOTFOUND, a TLS error, ...)
 * on `error.cause`. Surface that so logs are actionable — "fetch failed" alone
 * can't distinguish a transient blip from an IP-level block.
 */
function describeFetchError(err: unknown): string {
  const e = err as { message?: string; cause?: unknown };
  const cause = e.cause as { code?: string; message?: string } | undefined;
  const detail = cause?.code ?? cause?.message;
  return detail ? `${e.message ?? 'fetch failed'} (${detail})` : e.message ?? String(err);
}

async function fetchMamiText(
  url: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  accept = 'application/json,text/plain,*/*',
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) {
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  // Super Mami's CDN drops non-AR/datacenter IPs, so route via the AR proxy
  // when one is configured (no-op/undefined otherwise — direct connection).
  const dispatcher = getProxyDispatcher('mami');

  let res: Awaited<ReturnType<typeof undiciFetch>>;
  try {
    res = await undiciFetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: accept,
        'Accept-Language': 'es-AR,es;q=0.9',
      },
      signal: controller.signal,
      ...(dispatcher ? { dispatcher } : {}),
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new ScrapeError(
        'network_timeout',
        `Super Mami request timed out after ${timeoutMs}ms`,
        { cause: err },
      );
    }
    throw new ScrapeError(
      'network_error',
      `Super Mami request failed: ${describeFetchError(err)}`,
      { cause: err },
    );
  } finally {
    clearTimeout(timeoutId);
  }

  if (res.status === 404) {
    throw new ScrapeError('product_not_found', `Super Mami returned 404 for ${url}`, {
      httpStatus: 404,
    });
  }
  if (res.status === 429) {
    throw new ScrapeError('rate_limited', `Super Mami returned 429`, {
      httpStatus: 429,
    });
  }
  if (res.status >= 500) {
    throw new ScrapeError('site_server_error', `Super Mami returned ${res.status}`, {
      httpStatus: res.status,
    });
  }
  if (!res.ok) {
    throw new ScrapeError('unknown', `Super Mami returned status ${res.status}`, {
      httpStatus: res.status,
    });
  }

  return res.text();
}

/** Fetch a Super Mami URL and parse it as JSON (the `?format=json` payload). */
async function fetchMami(
  url: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<unknown> {
  const text = await fetchMamiText(url, signal, timeoutMs);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ScrapeError(
      'parse_failed',
      `Super Mami returned non-JSON body (first 200 chars: ${text.slice(0, 200)})`,
      { cause: err },
    );
  }
}

// =============================================================================
// Regular ("antes") price — HTML only
//
// The `?format=json` payload exposes ONLY `sku.activePrice` (the CURRENT price,
// i.e. the discounted one during a sale). It carries NO list/regular price. The
// product HTML page, however, renders the pre-discount price as
// `antes $X.XXX,XX x un.` inside the main price block (delimited by the
// `INICIO/FIN PRECIO LISTA Y DE REFERENCIA` comments — a stable anchor that
// excludes the related-product carousels, which also use `.precio-unidad`). We
// fetch the HTML alongside the JSON and, when the product is on sale, expose the
// regular price as `listPrice` so the export shows Precio_Regular (regular) and
// Precio_c_Oferta_1 (the discounted price) instead of the discount masquerading
// as the regular price.
// =============================================================================

// Main product price block, between the template's Spanish comments.
const PRICE_BLOCK_RE =
  /INICIO PRECIO LISTA Y DE REFERENCIA([\s\S]*?)FIN PRECIO LISTA Y DE REFERENCIA/i;
// The "antes" (regular) amount that follows it, e.g. `antes <span>$5,590.00</span>`.
const ANTES_RE = /antes[\s\S]{0,160}?\$\s*([\d.,]+)/i;

/** Parse a Mami money string ("5,590.00" → 5590.00): comma thousands, dot decimal. */
function parseMamiMoney(raw: string): number | undefined {
  const n = Number(raw.replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// The current selling price is the FIRST money token inside the price block
// (the big `<span style="font-size:25px">$2,790.00</span> x un.`), ahead of the
// "Precio s/Imp.Nac." and "antes" lines.
const CURRENT_RE = /\$\s*([\d.,]+)/;

/**
 * Extract both prices from a product's HTML price block (scoped to the main
 * block so related-product carousels can't leak in):
 *   - `current`: the price the customer pays today (first money token)
 *   - `regular`: the "antes" price shown only when the product is on sale
 *
 * This is the authoritative shelf price. We prefer it over the JSON's
 * `sku.activePrice`, which has been observed to lag — returning the regular
 * price for on-sale items (so the discount went undetected). Returns an empty
 * object when the block can't be found.
 */
export function extractMamiPrices(html: string): {
  current?: number;
  regular?: number;
} {
  const block = html.match(PRICE_BLOCK_RE)?.[1];
  if (!block) return {};
  const current = block.match(CURRENT_RE)?.[1];
  const regular = block.match(ANTES_RE)?.[1];
  return {
    current: current ? parseMamiMoney(current) : undefined,
    regular: regular ? parseMamiMoney(regular) : undefined,
  };
}

/**
 * Backwards-compatible helper: the regular ("antes") price only.
 * Prefer {@link extractMamiPrices} which also recovers the current price.
 */
export function extractRegularPrice(html: string): number | undefined {
  return extractMamiPrices(html).regular;
}

// =============================================================================
// EAN search (bulk product discovery)
//
// Endeca's keyword search doesn't index the barcode by default, but scoping the
// query to the EAN property via `Ntk=product.ean&Ntt=<ean>` returns the match.
// =============================================================================

async function searchByEan(
  ean: string,
  signal?: AbortSignal,
): Promise<EanSearchResult | null> {
  const searchUrl =
    `${MAMI_BASE_URL}/super/categoria` +
    `?Ntk=product.ean&Ntt=${encodeURIComponent(ean)}&Nty=1&format=json`;

  let body: unknown;
  try {
    body = await fetchMami(searchUrl, signal, SEARCH_TIMEOUT_MS);
  } catch {
    // Discovery treats any failure as "not found" and moves on.
    return null;
  }

  const node = findRecordNodeByEan(body, ean);
  if (!node) return null;

  const recordState = (node.detailsAction as { recordState?: string }).recordState ?? '';
  const idMatch = recordState.match(/\/_\/A-([^?]+)/);
  if (!idMatch?.[1]) return null;
  const recordId = idMatch[1];

  const attrs = node.attributes as Attrs;
  const name = attrStr(attrs, 'product.displayName') ?? 'producto';

  return {
    url: `${MAMI_BASE_URL}/super/producto/${slugify(name)}/_/A-${recordId}`,
    externalId: recordId,
  };
}

// =============================================================================
// Adapter
// =============================================================================

export const mamiAdapter: SupermarketAdapter = {
  id: 'mami',
  name: 'Super Mami',

  canonicalizeUrl,

  searchByEan,

  async resolveExternalId(canonicalUrl: string): Promise<string> {
    return resolveExternalIdFromUrl(canonicalUrl);
  },

  async scrape(ctx: ScrapeContext): Promise<ScrapeResult> {
    if (!ctx.externalUrl) {
      throw new ScrapeError(
        'unknown',
        `Super Mami adapter requires external_url; got null for sku=${ctx.externalId}`,
      );
    }
    const jsonUrl = toJsonUrl(ctx.externalUrl);
    ctx.logger.debug({ jsonUrl }, 'fetching Super Mami JSON');
    const body = await fetchMami(jsonUrl, ctx.signal, REQUEST_TIMEOUT_MS);
    const result = parseMamiResponse(body, ctx);
    const jsonPrice = result.price;

    // The HTML price-block figure is what the PDP shows, so it wins as `price`
    // whenever we can parse it. `sku.activePrice` has been observed BOTH above
    // the HTML figure (stale regular, hiding a sale — e.g. 6190 vs page 3990)
    // and below it (stale promo). Best-effort: HTML fetch failure keeps JSON.
    try {
      // Ask for HTML explicitly — the shared fetch helper defaults to JSON
      // Accept (for `?format=json`). Sending that on the PDP makes Endeca
      // return JSON (no price-block comments), so extractMamiPrices silently
      // finds nothing and we publish the stale JSON regular price.
      const html = await fetchMamiText(
        ctx.externalUrl,
        ctx.signal,
        REQUEST_TIMEOUT_MS,
        'text/html,application/xhtml+xml,*/*',
      );
      const { current, regular } = extractMamiPrices(html);
      if (current !== undefined && current > 0) {
        result.price = current;
      }
      // Regular = explicit "antes" if present, else the JSON price when it is
      // genuinely above what the page is charging.
      const candidate = [regular, jsonPrice].filter(
        (n): n is number => n !== undefined && n > result.price + 0.01,
      );
      if (candidate.length > 0) {
        result.listPrice = Math.max(...candidate);
      }
    } catch (err) {
      ctx.logger.debug(
        { err },
        'Super Mami price-block HTML fetch failed; publishing JSON price without listPrice',
      );
    }

    return result;
  },
};

// =============================================================================
// Pure parser — separated from `scrape` for unit testing against fixtures.
// =============================================================================

export function parseMamiResponse(
  body: unknown,
  ctx: Pick<ScrapeContext, 'externalId' | 'logger'>,
): ScrapeResult {
  const attrs = findPricedAttributes(body);
  if (!attrs) {
    throw new ScrapeError(
      'selector_failed',
      `Super Mami response had no priced record for sku=${ctx.externalId}`,
    );
  }

  const price = attrNum(attrs, 'sku.activePrice');
  if (price === undefined || !Number.isFinite(price) || price <= 0) {
    throw new ScrapeError(
      'price_missing',
      `Super Mami response had no usable price for sku=${ctx.externalId}`,
    );
  }

  // `product.disponible` is the textual availability flag ("Disponible").
  const disponible = attrStr(attrs, 'product.disponible');
  const inStock = disponible ? /disponible/i.test(disponible) : true;

  const name = attrStr(attrs, 'product.displayName') ?? attrStr(attrs, 'sku.displayName');
  const brand = attrStr(attrs, 'product.brand');
  const category =
    attrStr(attrs, 'parentCategory.displayName') ?? attrStr(attrs, 'product.category');
  const ean = attrStr(attrs, 'product.ean');
  const imageUrl = absoluteImage(
    attrStr(attrs, 'product.largeImage.url') ??
      attrStr(attrs, 'product.mediumImage.url'),
  );
  const mamiSku = attrStr(attrs, 'sku.repositoryId');
  // Reference unit price (per litre/kg) when the catalog exposes it.
  const unitPrice = attrNum(attrs, 'sku.precioUniReff');

  const result: ScrapeResult = {
    price,
    inStock,
    currency: 'ARS',
    tierUsed: 'api',
    promotions: [] as Promotion[],
    productInfo: {
      ...(name ? { name } : {}),
      ...(brand ? { brand } : {}),
      ...(category ? { category } : {}),
      ...(ean ? { ean } : {}),
      ...(imageUrl ? { imageUrl } : {}),
      metadata: {
        ...(mamiSku ? { mamiSku } : {}),
      },
    },
    rawData: { attributes: attrs },
  };

  if (
    unitPrice !== undefined &&
    Number.isFinite(unitPrice) &&
    unitPrice > 0 &&
    Math.abs(unitPrice - price) > 0.01
  ) {
    result.unitPrice = unitPrice;
  }

  return result;
}
