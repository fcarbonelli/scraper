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
 * URL pattern: `https://www.supermami.com.ar/super/producto/<slug>/_/A-<id>`
 *   → `<id>` (e.g. "2811471-2811471-s") is the external_id. Endeca resolves the
 *     page by this id regardless of the (decorative) slug, so EAN discovery can
 *     build URLs with a slug derived from the product name.
 */

import { ScrapeError } from '../shared/errors.js';
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

async function fetchMami(
  url: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<unknown> {
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
        Accept: 'application/json,text/plain,*/*',
        'Accept-Language': 'es-AR,es;q=0.9',
      },
      signal: controller.signal,
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
      `Super Mami request failed: ${(err as Error).message}`,
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

  const text = await res.text();
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
    return parseMamiResponse(body, ctx);
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
