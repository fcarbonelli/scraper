/**
 * Coto adapter.
 *
 * Coto exposes the same JSON their site consumes by appending `?format=json`
 * to any product URL. We fetch, parse, and extract:
 *
 *   - core price/stock fields              -> ScrapeResult strict columns
 *   - promotions (dtoDescuentos, etc.)     -> ScrapeResult.promotions
 *   - master catalog fields (name, EAN..)  -> ScrapeResult.productInfo
 *   - cleaned raw response                 -> ScrapeResult.rawData
 */

import { ScrapeError } from '../shared/errors.js';
import type {
  Promotion,
  ScrapeContext,
  ScrapeResult,
  SupermarketAdapter,
} from './types.js';

// =============================================================================
// Constants & types describing the Coto JSON structure
// =============================================================================

/** Default request timeout — abort fetches that hang. */
const REQUEST_TIMEOUT_MS = 15_000;

/** A reasonable, identifiable user agent. */
const USER_AGENT =
  'Mozilla/5.0 (compatible; PriceScraperBot/1.0; +https://example.com/bot)';

/**
 * Coto's `sku.dtoPrice` is a JSON-encoded string with this shape.
 *  - `precioLista`  = total consumer price (what you pay)
 *  - `precio`       = per-unit price (e.g. per liter)
 *  - `precioSinImp` = price without VAT
 */
interface CotoDtoPrice {
  precioLista: number;
  precio: number;
  precioSinImp?: number;
  skuId?: string;
}

/**
 * Top-level shape of `?format=json`. Only the path we read is typed —
 * everything else is `unknown`, so the type doesn't lie about reality.
 */
interface CotoResponse {
  contents?: Array<{
    Main?: Array<{
      record?: { attributes?: Record<string, unknown> };
      'json-ld'?: string;
    }>;
  }>;
}

/** Schema.org Product json-ld block embedded in the response. */
interface JsonLdProduct {
  offers?: {
    price?: number;
    priceCurrency?: string;
    availability?: string;
  };
}

// =============================================================================
// URL helpers
// =============================================================================

/** Strip `?format=json` (and any other scraping-only params) from a URL. */
function canonicalizeUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    u.searchParams.delete('format');
    // Leave any other params intact (Coto sometimes uses them for variants)
    return u.toString();
  } catch {
    return rawUrl;
  }
}

/**
 * Coto product URLs end with `/_/R-<id>` where <id> is the stable SKU code
 * Coto uses internally (e.g. "00591050-00591050-200"). We use it as the
 * external_id so the worker doesn't need the full URL.
 */
function resolveExternalIdFromUrl(canonicalUrl: string): string {
  const match = canonicalUrl.match(/\/R-([A-Za-z0-9-]+)/);
  if (match?.[1]) return match[1];
  // Fallback: use the path so we have *something* unique. Should not happen
  // for any real Coto product page.
  try {
    return new URL(canonicalUrl).pathname;
  } catch {
    return canonicalUrl;
  }
}

/** Take a canonical URL and append the `?format=json` we need to scrape it. */
function toJsonUrl(canonicalUrl: string): string {
  try {
    const u = new URL(canonicalUrl);
    u.searchParams.set('format', 'json');
    return u.toString();
  } catch {
    // Fall back to crude string append if URL parsing fails
    return canonicalUrl.includes('?')
      ? `${canonicalUrl}&format=json`
      : `${canonicalUrl}?format=json`;
  }
}

// =============================================================================
// Safe attribute getters
//
// Most attributes in Coto's response are arrays of strings: `["value"]`.
// A few are JSON-encoded strings (dtoPrice, dtoDescuentos, ...).
// These helpers handle both safely so the rest of the code stays readable.
// =============================================================================

type Attrs = Record<string, unknown>;

/** Read a string attribute (always wrapped in a single-element array). */
function getStr(attrs: Attrs, key: string): string | undefined {
  const v = attrs[key];
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  if (typeof v === 'string') return v;
  return undefined;
}

/** Read a numeric attribute (Coto stores these as strings too). */
function getNum(attrs: Attrs, key: string): number | undefined {
  const s = getStr(attrs, key);
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/** Read and JSON-parse a stringified attribute. Returns undefined on failure. */
function getJsonStr<T = unknown>(attrs: Attrs, key: string): T | undefined {
  const s = getStr(attrs, key);
  if (!s) return undefined;
  try {
    return JSON.parse(s) as T;
  } catch {
    return undefined;
  }
}

// =============================================================================
// Promotion extraction
// =============================================================================

/**
 * Normalize Coto's two promotion arrays into our shared `Promotion` shape.
 * - `dtoDescuentos`            -> generic discounts
 * - `dtoDescuentosMediosPago`  -> payment-method-specific discounts
 *
 * Coto's exact shape for a real, in-flight promo isn't documented; we keep
 * the original blob in `raw` so we never lose information, and best-effort
 * fill the structured fields.
 */
function extractPromotions(attrs: Attrs): Promotion[] {
  const promotions: Promotion[] = [];

  const generic = getJsonStr<unknown[]>(attrs, 'product.dtoDescuentos');
  if (Array.isArray(generic)) {
    for (const entry of generic) {
      promotions.push({
        type: 'discount',
        description: describePromo(entry) ?? 'Descuento',
        ...numericPromoFields(entry),
        raw: entry,
      });
    }
  }

  const payment = getJsonStr<unknown[]>(
    attrs,
    'product.dtoDescuentosMediosPago',
  );
  if (Array.isArray(payment)) {
    for (const entry of payment) {
      promotions.push({
        type: 'payment_method',
        description: describePromo(entry) ?? 'Descuento con medio de pago',
        ...numericPromoFields(entry),
        validPaymentMethods: extractPaymentMethods(entry),
        raw: entry,
      });
    }
  }

  return promotions;
}

/** Best-effort human description from a raw promo blob. */
function describePromo(entry: unknown): string | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  const o = entry as Record<string, unknown>;
  return (
    pickString(o, 'descripcion') ??
    pickString(o, 'description') ??
    pickString(o, 'nombre') ??
    pickString(o, 'name') ??
    pickString(o, 'leyenda')
  );
}

function numericPromoFields(entry: unknown): {
  discountPct?: number;
  discountAmount?: number;
} {
  if (!entry || typeof entry !== 'object') return {};
  const o = entry as Record<string, unknown>;
  const out: { discountPct?: number; discountAmount?: number } = {};
  const pct =
    pickNumber(o, 'porcentaje') ??
    pickNumber(o, 'porcentajeDescuento') ??
    pickNumber(o, 'descuentoPorcentaje');
  if (pct !== undefined) out.discountPct = pct;
  const amt =
    pickNumber(o, 'monto') ??
    pickNumber(o, 'descuento') ??
    pickNumber(o, 'descuentoMonto');
  if (amt !== undefined) out.discountAmount = amt;
  return out;
}

function extractPaymentMethods(entry: unknown): string[] | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  const o = entry as Record<string, unknown>;
  const candidates = [
    o['mediosPago'],
    o['mediosDePago'],
    o['paymentMethods'],
    o['banco'],
    o['banks'],
  ].filter(Boolean);
  for (const c of candidates) {
    if (Array.isArray(c) && c.every((x) => typeof x === 'string')) {
      return c as string[];
    }
    if (typeof c === 'string') return [c];
  }
  return undefined;
}

function pickString(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

function pickNumber(o: Record<string, unknown>, key: string): number | undefined {
  const v = o[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

// =============================================================================
// HTTP layer
// =============================================================================

async function fetchCoto(
  url: string,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const controller = new AbortController();
  // Compose the user's signal (if any) with our own timeout signal
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
        Accept: 'application/json,text/plain,*/*',
        'Accept-Language': 'es-AR,es;q=0.9',
      },
      signal: controller.signal,
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new ScrapeError('network_timeout', `Coto request timed out after ${REQUEST_TIMEOUT_MS}ms`, { cause: err });
    }
    throw new ScrapeError('network_error', `Coto request failed: ${(err as Error).message}`, { cause: err });
  } finally {
    clearTimeout(timeoutId);
  }

  if (res.status === 404) {
    throw new ScrapeError('product_not_found', `Coto returned 404 for ${url}`, { httpStatus: 404 });
  }
  if (res.status === 429) {
    throw new ScrapeError('rate_limited', `Coto returned 429 (rate limited)`, { httpStatus: 429 });
  }
  if (res.status >= 500) {
    throw new ScrapeError('site_server_error', `Coto returned ${res.status}`, { httpStatus: res.status });
  }
  if (!res.ok) {
    throw new ScrapeError('unknown', `Coto returned unexpected status ${res.status}`, { httpStatus: res.status });
  }

  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ScrapeError('parse_failed', `Coto returned non-JSON body (first 200 chars: ${text.slice(0, 200)})`, { cause: err });
  }
}

// =============================================================================
// Adapter
// =============================================================================

export const cotoAdapter: SupermarketAdapter = {
  id: 'coto',
  name: 'Coto Digital',

  canonicalizeUrl,

  async resolveExternalId(canonicalUrl: string): Promise<string> {
    return resolveExternalIdFromUrl(canonicalUrl);
  },

  async scrape(ctx: ScrapeContext): Promise<ScrapeResult> {
    if (!ctx.externalUrl) {
      throw new ScrapeError(
        'unknown',
        `Coto adapter requires external_url; got null for sku=${ctx.externalId}`,
      );
    }

    const jsonUrl = toJsonUrl(ctx.externalUrl);
    ctx.logger.debug({ jsonUrl }, 'fetching Coto JSON');

    const body = (await fetchCoto(jsonUrl, ctx.signal)) as CotoResponse;
    return parseCotoResponse(body, ctx);
  },
};

/**
 * Pure parser — separated from `scrape` so it's trivially unit-testable
 * by passing in a saved JSON fixture.
 */
export function parseCotoResponse(
  body: CotoResponse,
  ctx: Pick<ScrapeContext, 'externalId' | 'logger'>,
): ScrapeResult {
  const main = body.contents?.[0]?.Main?.[0];
  const attrs = main?.record?.attributes;
  if (!attrs) {
    throw new ScrapeError('selector_failed', 'Coto response missing contents[0].Main[0].record.attributes');
  }

  // -- Prices ----------------------------------------------------------------
  const dtoPrice = getJsonStr<CotoDtoPrice>(attrs, 'sku.dtoPrice');
  // Fallbacks if dtoPrice is missing/malformed
  const activePrice = getNum(attrs, 'sku.activePrice');
  const referencePrice = getNum(attrs, 'sku.referencePrice');

  const price = dtoPrice?.precioLista ?? activePrice;
  if (price === undefined || !Number.isFinite(price) || price <= 0) {
    throw new ScrapeError(
      'price_missing',
      `Coto response had no usable price for sku=${ctx.externalId}`,
    );
  }

  const unitPrice = dtoPrice?.precio ?? referencePrice;
  const formato = getStr(attrs, 'product.cFormato')?.trim();

  // -- Stock + currency from json-ld ----------------------------------------
  let inStock = true;          // fallback assumption if json-ld is missing
  let currency = 'ARS';
  if (typeof main?.['json-ld'] === 'string') {
    try {
      const jsonLd = JSON.parse(main['json-ld']) as JsonLdProduct;
      const availability = jsonLd.offers?.availability ?? '';
      inStock = /InStock/i.test(availability);
      if (jsonLd.offers?.priceCurrency) currency = jsonLd.offers.priceCurrency;
    } catch (err) {
      ctx.logger.warn({ err }, 'failed to parse Coto json-ld, falling back to defaults');
    }
  }

  // -- Promotions ------------------------------------------------------------
  const promotions = extractPromotions(attrs);

  // -- Master catalog data ---------------------------------------------------
  const name = getStr(attrs, 'product.displayName');
  const brand = getStr(attrs, 'product.brand') ?? getStr(attrs, 'product.MARCA');
  const category = getStr(attrs, 'product.category');
  const ean = getStr(attrs, 'product.eanPrincipal');
  const imageUrl =
    getStr(attrs, 'product.mediumImage.url') ??
    getStr(attrs, 'product.largeImage.url');
  const department = getStr(attrs, 'product.LDEPAR');
  const quantity = getStr(attrs, 'sku.quantity');
  const unit = quantity && formato ? `${quantity} ${formato}` : (formato ?? quantity);
  const cotoSku = getStr(attrs, 'sku.repositoryId');

  const result: ScrapeResult = {
    price,
    inStock,
    currency,
    tierUsed: 'api',
    promotions,
    productInfo: {
      ...(name ? { name } : {}),
      ...(brand ? { brand } : {}),
      ...(category ? { category } : {}),
      ...(unit ? { unit } : {}),
      ...(ean ? { ean } : {}),
      ...(imageUrl ? { imageUrl } : {}),
      metadata: {
        ...(department ? { department } : {}),
        ...(cotoSku ? { cotoSku } : {}),
      },
    },
    rawData: {
      // Slim record kept for forensics — full attribute bag is large but
      // small relative to a daily snapshot row, and useful when something
      // looks weird later.
      attributes: attrs,
      ...(typeof main?.['json-ld'] === 'string'
        ? { jsonLd: main['json-ld'] }
        : {}),
    },
  };

  // Only set unitPrice if it actually differs from the total price (otherwise
  // it's just a duplicate value).
  if (
    unitPrice !== undefined &&
    Number.isFinite(unitPrice) &&
    unitPrice > 0 &&
    Math.abs(unitPrice - price) > 0.01
  ) {
    result.unitPrice = unitPrice;
    if (formato) result.unitPricePer = formato;
  }

  return result;
}
