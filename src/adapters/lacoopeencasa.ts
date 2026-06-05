/**
 * La Coope en Casa adapter (Cooperativa Obrera).
 *
 * The site is an Angular SPA that talks to a Be2-framework JSON API:
 *
 *   GET https://api.lacoopeencasa.coop/api/articulo/detalle
 *       ?cod_interno=<id>&simple=false
 *
 * Response envelope is `{ estado, mensaje, datos, ticket }`:
 *   - estado === 1 → OK; `datos` holds the product object.
 *   - estado === 3 → not found (or invalid params).
 *
 * The user-facing URL is `/producto/<slug>/<id>` and the trailing numeric id
 * is exactly what the API needs (Angular router picks it out of the path).
 * No auth, no cookies, no special headers.
 *
 * Caveat: the public API does NOT expose EAN/GTIN, so we cannot dedupe master
 * `products` rows by EAN for this supermarket. Each LCEC product becomes its
 * own master row unless the EAN is filled in manually later.
 */

import { ScrapeError } from '../shared/errors.js';
import type {
  ProductInfo,
  Promotion,
  ScrapeContext,
  ScrapeResult,
  SupermarketAdapter,
} from './types.js';
import { runWithGeoFallback } from './geo-retry.js';
import type { Zone } from './zones.js';

const REQUEST_TIMEOUT_MS = 15_000;
const API_BASE = 'https://api.lacoopeencasa.coop/api';
const PRODUCT_HOST = 'www.lacoopeencasa.coop';

const USER_AGENT =
  'Mozilla/5.0 (compatible; PriceScraperBot/1.0; +https://example.com/bot)';

// =============================================================================
// API response shapes
// =============================================================================

interface LcecEnvelope<T> {
  estado: number;
  mensaje: string;
  datos: T | null;
}

/**
 * Subset of the `articulo/detalle` payload we actually read.
 * The API exposes all numbers as strings (decimal-stringified); we coerce.
 */
interface LcecArticulo {
  cod_interno?: string;
  descripcion?: string;
  precio?: string;
  precio_anterior?: string;
  precio_promo?: string | null;
  precio_sin_impuestos?: string;
  precio_unitario?: string;
  unimed_unitario_desc?: string;
  gramaje?: string;
  unimed_desc?: string;
  uxc?: string;
  imagen?: string;
  imagen_max?: string;
  imagen_min?: string;
  marca_desc?: string;
  id_marca?: string;
  id_categoria?: string;
  categoria_desc?: string;
  categoria_inicial_desc?: string;
  categoria_secundaria_desc?: string;
  categoria_terciaria_desc?: string;
  id_familia?: string;
  stock?: string;
  disponibilidad?: string; // "true" | "false"
  existe_promo?: string;
  descripcion_promo?: string | null;
  descuento_porcentaje_promo?: string | null;
  descuento_precio_promo?: string | null;
  vigencia_promo?: string | null;
  desc_larga?: string;
}

// =============================================================================
// URL helpers
// =============================================================================

/**
 * Canonicalize: strip query/hash, normalize trailing slash, lowercase host.
 * LCEC product URLs are `/producto/<slug>/<id>`; we leave the path intact.
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

/** Pull the trailing numeric `<id>` out of `/producto/<slug>/<id>`. */
function extractProductId(canonicalUrl: string): string | null {
  try {
    const path = new URL(canonicalUrl).pathname;
    const m = path.match(/\/producto\/[^/]+\/(\d+)$/);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

// =============================================================================
// HTTP layer
// =============================================================================

async function fetchLcec<T>(
  url: string,
  signal: AbortSignal | undefined,
  context: string,
): Promise<LcecEnvelope<T>> {
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
        Accept: 'application/json,text/plain,*/*',
        'Accept-Language': 'es-AR,es;q=0.9',
      },
      signal: controller.signal,
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new ScrapeError(
        'network_timeout',
        `LCEC ${context} timed out after ${REQUEST_TIMEOUT_MS}ms`,
        { cause: err },
      );
    }
    throw new ScrapeError(
      'network_error',
      `LCEC ${context} failed: ${(err as Error).message}`,
      { cause: err },
    );
  } finally {
    clearTimeout(timeoutId);
  }

  if (res.status === 429) {
    throw new ScrapeError('rate_limited', `LCEC ${context} returned 429`, {
      httpStatus: 429,
    });
  }
  if (res.status >= 500) {
    throw new ScrapeError(
      'site_server_error',
      `LCEC ${context} returned ${res.status}`,
      { httpStatus: res.status },
    );
  }

  const text = await res.text();
  let body: LcecEnvelope<T>;
  try {
    body = JSON.parse(text) as LcecEnvelope<T>;
  } catch (err) {
    throw new ScrapeError(
      'parse_failed',
      `LCEC ${context} returned non-JSON body (first 200 chars: ${text.slice(0, 200)})`,
      { cause: err },
    );
  }

  // The API answers HTTP 404 with the same envelope; surface as product_not_found.
  if (res.status === 404 || body.estado === 3) {
    throw new ScrapeError(
      'product_not_found',
      `LCEC ${context} not found: ${body.mensaje || 'no message'}`,
      { httpStatus: res.status === 404 ? 404 : undefined },
    );
  }
  if (body.estado !== 1) {
    throw new ScrapeError(
      'unknown',
      `LCEC ${context} returned estado=${body.estado} (${body.mensaje})`,
    );
  }
  return body;
}

// =============================================================================
// Promotions
// =============================================================================

/**
 * LCEC encodes a single optional promo in flat fields on the article. We turn
 * it into our shared `Promotion` shape; everything else is preserved in
 * `rawData`.
 */
function extractPromotions(a: LcecArticulo): Promotion[] {
  if (a.existe_promo !== 'true') return [];
  const out: Promotion = {
    type: 'discount',
    description: a.descripcion_promo?.trim() || 'Promoción',
  };
  const pct = parseFloatOrUndefined(a.descuento_porcentaje_promo);
  if (pct !== undefined) out.discountPct = pct;
  const amt = parseFloatOrUndefined(a.descuento_precio_promo);
  if (amt !== undefined) out.discountAmount = amt;
  return [out];
}

function parseFloatOrUndefined(v: string | null | undefined): number | undefined {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

// =============================================================================
// Adapter
// =============================================================================

export const lacoopeencasaAdapter: SupermarketAdapter = {
  id: 'lacoopeencasa',
  name: 'La Coope en Casa',

  canonicalizeUrl,

  async resolveExternalId(canonicalUrl: string): Promise<string> {
    const id = extractProductId(canonicalUrl);
    if (!id) {
      throw new ScrapeError(
        'unknown',
        `LCEC URL doesn't match /producto/<slug>/<id>: ${canonicalUrl}`,
      );
    }
    return id;
  },

  async scrape(ctx: ScrapeContext): Promise<ScrapeResult> {
    if (!ctx.externalId) {
      throw new ScrapeError(
        'unknown',
        `LCEC adapter requires external_id (cod_interno), got empty.`,
      );
    }

    // Geo-retry assessment (2026-06): La Coope en Casa (Cooperativa Obrera) is
    // a single regional cooperative and its `articulo/detalle` endpoint did not
    // expose a confirmed per-branch parameter. So geo-retry is OFF unless an
    // operator configures a branch query-param via `supermarkets.config`
    // (e.g. `{ "lcecZoneParam": "id_sucursal",
    //          "zones": [{ "id": "...", "postalCode": "...", "code": "<suc>" }] }`).
    // Until then this behaves exactly as before (default branch only).
    const zoneParam = readLcecZoneParam(ctx.config.config);
    if (!zoneParam) {
      return scrapeLcecZone(ctx, null, undefined);
    }
    return runWithGeoFallback({
      logger: ctx.logger,
      config: ctx.config.config,
      attempt: (zone) => scrapeLcecZone(ctx, zone, zoneParam),
    });
  },
};

/** Read the optional LCEC branch query-param name from supermarket config. */
function readLcecZoneParam(
  config: Record<string, unknown> | undefined,
): string | undefined {
  const v = config?.['lcecZoneParam'];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

/**
 * Single LCEC scrape, optionally scoped to a zone via a configured branch param.
 *
 * - `zone === null`: the default request (current behavior).
 * - `zone` provided: append `<zoneParam>=<zone.code>`. If the zone has no `code`
 *   (or no param configured), throw `product_not_found` so the fallback loop
 *   moves on.
 */
async function scrapeLcecZone(
  ctx: ScrapeContext,
  zone: Zone | null,
  zoneParam: string | undefined,
): Promise<ScrapeResult> {
  let url = `${API_BASE}/articulo/detalle?cod_interno=${encodeURIComponent(
    ctx.externalId,
  )}&simple=false`;

  if (zone) {
    if (!zoneParam || !zone.code) {
      throw new ScrapeError(
        'product_not_found',
        `LCEC: zone ${zone.id} has no branch code configured`,
      );
    }
    url += `&${encodeURIComponent(zoneParam)}=${encodeURIComponent(zone.code)}`;
  }

  ctx.logger.debug({ url, zone: zone?.id ?? 'default' }, 'fetching LCEC articulo/detalle');
  const body = await fetchLcec<LcecArticulo>(url, ctx.signal, 'articulo/detalle');
  return parseLcecResponse(body, ctx);
}

// =============================================================================
// Pure parser — split out so we can unit-test against saved fixtures.
// =============================================================================

export function parseLcecResponse(
  body: LcecEnvelope<LcecArticulo>,
  ctx: Pick<ScrapeContext, 'externalId'>,
): ScrapeResult {
  const a = body.datos;
  if (!a) {
    throw new ScrapeError(
      'product_not_found',
      `LCEC articulo/detalle returned datos=null for cod_interno=${ctx.externalId}`,
    );
  }

  // -- Price: prefer current `precio`; if a promo price is set, use it as the
  //    "what the user pays" value and surface the regular `precio` as listPrice.
  const regular = parseFloatOrUndefined(a.precio);
  const promo = parseFloatOrUndefined(a.precio_promo);
  const price = promo ?? regular;
  if (price === undefined || price <= 0) {
    throw new ScrapeError(
      'price_missing',
      `LCEC offer has no usable price (cod_interno=${ctx.externalId})`,
    );
  }
  let listPrice: number | undefined;
  if (promo !== undefined && regular !== undefined && regular > promo + 0.01) {
    listPrice = regular;
  }

  // -- Stock: explicit `disponibilidad` flag wins; fall back to numeric stock.
  const stockNum = parseFloatOrUndefined(a.stock);
  const inStock =
    a.disponibilidad === 'true' || (stockNum !== undefined && stockNum > 0);

  // -- Per-unit price (e.g. per Litro)
  const unitPrice = parseFloatOrUndefined(a.precio_unitario);
  const unitPricePer = a.unimed_unitario_desc?.trim() || undefined;

  // -- Catalog data ----------------------------------------------------------
  const productInfo: ProductInfo = {};
  if (a.descripcion) productInfo.name = a.descripcion.trim();
  if (a.marca_desc) productInfo.brand = a.marca_desc.trim();
  // Use the leaf-most non-empty category we have.
  const category =
    a.categoria_terciaria_desc ||
    a.categoria_secundaria_desc ||
    a.categoria_inicial_desc ||
    a.categoria_desc;
  if (category) productInfo.category = category.trim();
  // Compose unit label like "400 cm3" from the gramaje + unit-of-measure
  if (a.gramaje && a.unimed_desc) {
    // Trim trailing zeros on the decimal: "400.00" -> "400"
    const grams = a.gramaje.replace(/\.?0+$/, '');
    productInfo.unit = `${grams} ${a.unimed_desc.trim()}`;
  } else if (a.gramaje) {
    productInfo.unit = a.gramaje.replace(/\.?0+$/, '');
  }
  if (a.imagen_max || a.imagen) {
    productInfo.imageUrl = (a.imagen_max ?? a.imagen)!.startsWith('http')
      ? (a.imagen_max ?? a.imagen)!
      : `https://${PRODUCT_HOST}${a.imagen_max ?? a.imagen}`;
  }
  // EAN is intentionally absent — LCEC API doesn't expose it.

  const metadata: Record<string, unknown> = {};
  if (a.id_categoria) metadata.idCategoria = a.id_categoria;
  if (a.id_marca) metadata.idMarca = a.id_marca;
  if (a.id_familia) metadata.idFamilia = a.id_familia;
  if (a.uxc) metadata.unitsPerCase = a.uxc;
  if (Object.keys(metadata).length > 0) productInfo.metadata = metadata;

  const result: ScrapeResult = {
    price,
    inStock,
    currency: 'ARS',
    tierUsed: 'api',
    promotions: extractPromotions(a),
    productInfo,
    rawData: { datos: a },
  };
  if (listPrice !== undefined) result.listPrice = listPrice;
  if (unitPrice !== undefined && unitPrice > 0 && Math.abs(unitPrice - price) > 0.01) {
    result.unitPrice = unitPrice;
    if (unitPricePer) result.unitPricePer = unitPricePer;
  }
  return result;
}
