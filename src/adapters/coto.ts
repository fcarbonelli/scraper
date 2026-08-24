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
  EanSearchResult,
  Promotion,
  ScrapeContext,
  ScrapeResult,
  SupermarketAdapter,
} from './types.js';
import { runWithGeoFallback } from './geo-retry.js';
import type { Zone } from './zones.js';

// =============================================================================
// Constants & types describing the Coto JSON structure
// =============================================================================

/** Default request timeout — abort fetches that hang. */
const REQUEST_TIMEOUT_MS = 15_000;

/** A reasonable, identifiable user agent. */
const USER_AGENT =
  'Mozilla/5.0 (compatible; PriceScraperBot/1.0; +https://example.com/bot)';

/** Public base URL for building canonical product URLs during EAN discovery. */
const COTO_BASE_URL = 'https://www.cotodigital.com.ar';

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

/**
 * Coto product URLs sometimes carry tracking/assembler params copied from
 * search results (e.g. "?Dy=1&assemblerContentCollection=..."). None of
 * those are needed to identify the product — the SKU id in the path is
 * canonical. Strip the whole query string + hash so:
 *   1) `format=json` we append at scrape time is the ONLY param, and
 *   2) the URL stored in the DB is the clean, shareable form.
 */
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
//
// Coto's REAL discount payloads (verified against the live `?format=json`
// endpoint, 2026-08) — the field names are NOT the ones you'd guess:
//
//   product.dtoDescuentos: [{
//     "id": "37206663",
//     "textoVigencia": " ",
//     "textoPrecioRegular": "Precio Contado: $1900",
//     "precioRegular": "",
//     "textoDescuento": "20%Dto",
//     "precioDescuento": "$1520.00",
//     "imagenDescuento": " ",
//     "comentarios": " No acumulable con otras promos"
//   }]
//   product.dtoDescuentosMediosPago: [{
//     "id": "80372620",
//     "precioCuota": "$7791.58",
//     "cantidadCuotas": "12",
//     "imagenDescuento": "/content/images/cdigi/ofertas/…png"
//   }]
//
// The previous implementation looked for `descripcion` / `porcentaje` / `monto`
// (fields Coto never emits), so EVERY Coto discount was silently dropped:
// `discountPct` and the offer price came back undefined, and the client_base
// export showed the product at full price with no `Precio_c_Oferta_1` and no
// `Descuento_Unitario`. We now parse the actual fields.
// =============================================================================

/**
 * Normalize Coto's two promotion arrays into our shared `Promotion` shape.
 * - `dtoDescuentos`            -> generic price discounts (the "%Dto" offers)
 * - `dtoDescuentosMediosPago`  -> financing (cuotas) offers
 *
 * `regularPrice` is the product's list price (`dtoPrice.precioLista`); we use
 * it to sanity-check the parsed discounted price and to derive the absolute
 * discount when a percentage isn't published.
 */
function extractPromotions(attrs: Attrs, regularPrice: number): Promotion[] {
  const promotions: Promotion[] = [];

  const generic = getJsonStr<unknown[]>(attrs, 'product.dtoDescuentos');
  if (Array.isArray(generic)) {
    for (const entry of generic) {
      const promo = cotoDiscountPromo(entry, regularPrice);
      if (promo) promotions.push(promo);
    }
  }

  const payment = getJsonStr<unknown[]>(
    attrs,
    'product.dtoDescuentosMediosPago',
  );
  if (Array.isArray(payment)) {
    for (const entry of payment) {
      const promo = cotoPaymentPromo(entry);
      if (promo) promotions.push(promo);
    }
  }

  return promotions;
}

/** Round to 2 decimals (currency). */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Parse a Coto money string into a number. Handles both "$1520.00" (dot
 * decimal, as Coto's promo strings use today) and the Argentine "$1.520,00"
 * (dot thousands, comma decimal) form defensively.
 */
function parseMoney(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw !== 'string') return undefined;
  const cleaned = raw.replace(/[^\d.,]/g, '');
  if (!cleaned) return undefined;

  const hasDot = cleaned.includes('.');
  const hasComma = cleaned.includes(',');
  let normalized = cleaned;
  if (hasDot && hasComma) {
    // The last-appearing separator is the decimal one.
    normalized =
      cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')
        ? cleaned.replace(/\./g, '').replace(',', '.')
        : cleaned.replace(/,/g, '');
  } else if (hasComma) {
    normalized = cleaned.replace(',', '.');
  }
  const n = Number(normalized);
  return Number.isFinite(n) ? n : undefined;
}

/** Parse a percentage out of a "20%Dto" / "35 % Dto" style string. */
function parsePercent(raw: unknown): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const m = raw.match(/(\d+(?:[.,]\d+)?)\s*%/);
  if (!m?.[1]) return undefined;
  const n = Number(m[1].replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Non-empty trimmed string value, or undefined. */
function pickString(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

/** Turn one `dtoDescuentos` entry into a Promotion (null if it carries nothing). */
function cotoDiscountPromo(entry: unknown, regularPrice: number): Promotion | null {
  if (!entry || typeof entry !== 'object') return null;
  const o = entry as Record<string, unknown>;

  const pct = parsePercent(o['textoDescuento']);
  const offer = parseMoney(o['precioDescuento']);
  const texto = pickString(o, 'textoDescuento');
  const comentarios = pickString(o, 'comentarios');
  const description =
    [texto, comentarios].filter(Boolean).join(' — ') || 'Descuento';

  const promo: Promotion = { type: 'discount', description, raw: entry };
  if (pct !== undefined) promo.discountPct = pct;
  // Only trust the parsed discounted price when it's below the list price —
  // guards against a mis-parse or a sentinel producing a bogus "offer".
  if (offer !== undefined && offer > 0 && regularPrice > 0 && offer < regularPrice) {
    promo.offerPrice = offer;
    if (promo.discountPct === undefined) {
      promo.discountAmount = round2(regularPrice - offer);
    }
  }

  // Drop entries that carry no usable discount AND no distinctive text (an
  // empty `[]` never reaches here, but a blank object shouldn't become a promo).
  if (
    promo.discountPct === undefined &&
    promo.offerPrice === undefined &&
    promo.discountAmount === undefined &&
    description === 'Descuento'
  ) {
    return null;
  }
  return promo;
}

/** Turn one `dtoDescuentosMediosPago` entry into a financing Promotion. */
function cotoPaymentPromo(entry: unknown): Promotion | null {
  if (!entry || typeof entry !== 'object') return null;
  const o = entry as Record<string, unknown>;

  const cuotas = pickString(o, 'cantidadCuotas');
  const precioCuota = pickString(o, 'precioCuota');
  let description: string;
  if (cuotas && precioCuota) description = `${cuotas} cuotas de ${precioCuota}`;
  else if (cuotas) description = `${cuotas} cuotas`;
  else description = 'Descuento con medio de pago';

  // Financing is not a price cut, so no discountPct/offerPrice — this is
  // informational (it fills Promocion_1/2, never the offer price columns).
  return { type: 'payment_method', description, raw: entry };
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
// EAN search (bulk product discovery)
//
// Coto runs on Oracle Commerce / Endeca. Its default keyword search does NOT
// index the barcode (a plain `Ntt=<ean>` query returns zero records), but
// Endeca lets us scope a keyword query to a single record property via `Ntk`.
// `Ntk=product.eanPrincipal&Ntt=<ean>` returns the matching product's record.
//
// We then build the canonical product URL from the record id: Coto resolves
// product pages by the `/_/R-<id>` path segment regardless of the (decorative)
// slug, so a slug derived from the product name is sufficient and stable.
// =============================================================================

/** Endeca search response timeout (independent of the scrape timeout). */
const SEARCH_TIMEOUT_MS = 15_000;

/**
 * Build a URL-safe slug from a product name. The slug is decorative — Coto
 * resolves the product by the `R-<id>` segment — so exact parity with Coto's
 * own slug isn't required, only that it's a clean path segment.
 */
function slugify(name: string): string {
  return (
    name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // strip accents
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-') // non-alphanumeric -> hyphen
      .replace(/^-+|-+$/g, '') || // trim leading/trailing hyphens
    'producto'
  );
}

/** First string value of an Endeca attribute (attributes are arrays of strings). */
function attrStr(attrs: Record<string, unknown>, key: string): string | undefined {
  const v = attrs[key];
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return undefined;
}

/**
 * Recursively walk Coto's Endeca JSON and return the `attributes` of the first
 * record whose `product.eanPrincipal` exactly matches `ean`.
 *
 * Matching on the EAN (rather than just taking the first record) is important:
 * a search-results page can include unrelated products in recommendation /
 * "visited" carousels, and we must not map the client EAN to one of those.
 */
function findRecordByEan(node: unknown, ean: string): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findRecordByEan(item, ean);
      if (found) return found;
    }
    return null;
  }

  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    const attrs = obj.attributes;
    if (attrs && typeof attrs === 'object') {
      const eanAttr = (attrs as Record<string, unknown>)['product.eanPrincipal'];
      if (Array.isArray(eanAttr) && String(eanAttr[0]) === ean) {
        return attrs as Record<string, unknown>;
      }
    }
    for (const value of Object.values(obj)) {
      const found = findRecordByEan(value, ean);
      if (found) return found;
    }
  }

  return null;
}

/**
 * Search Coto by EAN. Returns the canonical product URL + external_id, or null
 * when the barcode isn't in Coto's catalog (or the request fails — discovery
 * treats null as "not found" and simply moves on to the next EAN).
 */
async function searchByEan(
  ean: string,
  signal?: AbortSignal,
): Promise<EanSearchResult | null> {
  const searchUrl =
    `${COTO_BASE_URL}/sitios/cdigi/categoria` +
    `?Ntk=product.eanPrincipal&Ntt=${encodeURIComponent(ean)}&Nty=1&format=json`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  if (signal) {
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  let body: unknown;
  try {
    const res = await fetch(searchUrl, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json,text/plain,*/*',
        'Accept-Language': 'es-AR,es;q=0.9',
      },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    body = await res.json();
  } catch {
    // Network error / timeout / non-JSON — treat as "not found" so discovery
    // keeps going. (The scrape path, by contrast, surfaces these as errors.)
    return null;
  } finally {
    clearTimeout(timeoutId);
  }

  const attrs = findRecordByEan(body, ean);
  if (!attrs) return null;

  const recordId = attrStr(attrs, 'record.id');
  if (!recordId) return null;

  const name =
    attrStr(attrs, 'product.description') ?? attrStr(attrs, 'sku.displayName') ?? 'producto';

  return {
    // `record.id` (e.g. "00591050-00591050-200") is exactly what
    // resolveExternalIdFromUrl() would parse back out of the `/R-<id>` path,
    // so we pass it as the pre-resolved external_id to skip a round-trip.
    url: `${COTO_BASE_URL}/sitios/cdigi/productos/${slugify(name)}/_/R-${recordId}`,
    externalId: recordId,
  };
}

// =============================================================================
// Adapter
// =============================================================================

export const cotoAdapter: SupermarketAdapter = {
  id: 'coto',
  name: 'Coto Digital',

  canonicalizeUrl,

  searchByEan,

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

    // Geo-retry assessment (2026-06): Coto Digital's `?format=json` endpoint
    // serves a SINGLE national price list (priceList200) and exposes no
    // per-sucursal stock here — availability is only resolved at cart/checkout.
    // So there is no zone mechanism to exploit by default and geo-retry would
    // just repeat identical requests. We therefore only enable the location
    // sweep when an operator has configured a query-param mechanism in
    // `supermarkets.config` (e.g. `{ "cotoZoneParam": "idSucursal",
    // "zones": [{ "id": "...", "postalCode": "...", "code": "<sucursal>" }] }`).
    // Until then this behaves exactly as before (default catalog only).
    const zoneParam = readCotoZoneParam(ctx.config.config);
    if (!zoneParam) {
      return scrapeCotoZone(ctx, null, undefined);
    }
    return runWithGeoFallback({
      logger: ctx.logger,
      config: ctx.config.config,
      attempt: (zone) => scrapeCotoZone(ctx, zone, zoneParam),
    });
  },
};

/** Read the optional Coto sucursal query-param name from supermarket config. */
function readCotoZoneParam(
  config: Record<string, unknown> | undefined,
): string | undefined {
  const v = config?.['cotoZoneParam'];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

/**
 * Single Coto scrape, optionally scoped to a zone via a configured query param.
 *
 * - `zone === null`: the default catalog request (current behavior).
 * - `zone` provided: append `<zoneParam>=<zone.code>` to the JSON URL. If the
 *   zone has no `code` (or no param configured), throw `product_not_found` so
 *   the fallback loop simply moves on.
 */
async function scrapeCotoZone(
  ctx: ScrapeContext,
  zone: Zone | null,
  zoneParam: string | undefined,
): Promise<ScrapeResult> {
  let jsonUrl = toJsonUrl(ctx.externalUrl!);

  if (zone) {
    if (!zoneParam || !zone.code) {
      throw new ScrapeError(
        'product_not_found',
        `Coto: zone ${zone.id} has no sucursal code configured`,
      );
    }
    const u = new URL(jsonUrl);
    u.searchParams.set(zoneParam, zone.code);
    jsonUrl = u.toString();
  }

  ctx.logger.debug({ jsonUrl, zone: zone?.id ?? 'default' }, 'fetching Coto JSON');
  const body = (await fetchCoto(jsonUrl, ctx.signal)) as CotoResponse;
  return parseCotoResponse(body, ctx);
}

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
  const promotions = extractPromotions(attrs, price);

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
