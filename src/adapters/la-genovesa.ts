/**
 * La Genovesa adapter (lagenovesadigital.com.ar — bespoke ASP.NET Core Razor).
 *
 * La Genovesa (supermarket chain, Zona Sur de GBA) runs a custom ASP.NET Core
 * Razor Pages storefront. There is no JSON product API and no JSON-LD, so we
 * read the server-rendered HTML. Two endpoints make this workable:
 *
 *   1. EAN discovery — the site has a barcode scanner page (/LectorQR) backed by
 *      a resolver handler:
 *        GET /LectorQR/?handler=ObtenerArticuloID&SCANNER=<ean>
 *      On a hit it returns JSON:
 *        { msj:"OK", articulo, promo, tipo, cliente, idpres, dom }
 *      On a miss it returns a non-OK body (a SQL/exception object), because the
 *      stored proc yields an empty table — that's our "not carried" signal.
 *
 *   2. Product detail — built from the resolver fields:
 *        GET /DetalleProducto?ArticuloID=<a>&PromID=<p>&Tipo=<t>
 *            &ClienteID=<c>&PresID=<pr>&IDDom=<d>
 *      The page exposes the barcode, name and price in fixed CSS hooks:
 *        <p class="titulo">…name…</p>
 *        <div class="col textDescripcionDetalle"> …EAN… </div>
 *        <div class="textPrecioUnitario"> $ 3290,00</div>
 *        ( $1645,00 x 1000 ml )   ← per-unit reference price
 *      Product images are named by EAN: /Images/Productos/L/<ean>.jpg
 *
 * Session: product pages require an ASP.NET session cookie (a cold visit is
 * bounced to /Home to pick a branch). We bootstrap one with a GET to /Home and
 * reuse it; if a later request is bounced (expired session) we refresh once.
 * Prices come from the guest/default zone — good enough for monitoring.
 *
 * external_id is a composite of the identifying query params:
 *   `<ArticuloID>_<Tipo>_<PresID>_<PromID>`
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

const REQUEST_TIMEOUT_MS = 15_000;
const SEARCH_TIMEOUT_MS = 20_000;

const GENOVESA_HOST = 'lagenovesadigital.com.ar';
const BASE_URL = 'https://www.lagenovesadigital.com.ar';

// Guest defaults the site itself uses when no account/address is selected.
const GUEST_CLIENTE_ID = '-573698';
const DEFAULT_IDDOM = '1';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// =============================================================================
// Resolver (barcode → product) response shape
// =============================================================================

interface ObtenerArticuloResult {
  msj?: string;
  articulo?: number | string;
  promo?: number | string;
  tipo?: number | string;
  cliente?: number | string;
  idpres?: number | string;
  dom?: number | string;
}

// =============================================================================
// Networking — browser-like cookie jar + manual redirect following
// =============================================================================
//
// On a cold request La Genovesa replies with cookie-setting 302 redirects (the
// ASP.NET session / culture cookie). Node's fetch does NOT resend Set-Cookie
// across redirect hops, so `redirect: 'follow'` loops forever ("redirect count
// exceeded"). We follow redirects by hand, carrying an accumulating cookie jar
// like a browser does — the cookie set on hop 1 stops the loop on hop 2.

/** Module-level cookie jar (name → value), shared across requests/products. */
const cookieJar = new Map<string, string>();
let sessionReady = false;

/** Build a human-readable detail string from a fetch failure (surfaces cause). */
function describeFetchError(err: unknown): string {
  const e = err as { message?: string; cause?: unknown };
  const cause = e.cause as { code?: string; message?: string } | undefined;
  const detail = cause?.code ?? cause?.message;
  return detail ? `${e.message ?? 'fetch failed'} (${detail})` : e.message ?? String(err);
}

/** Merge a response's Set-Cookie headers into the jar (handles HttpOnly too). */
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

interface GenovesaResponse {
  status: number;
  /** URL after manually following redirects (used to detect a Home bounce). */
  finalUrl: string;
  body: string;
}

/**
 * GET a path, manually following up to 8 redirects while accumulating cookies.
 * Maps transport/HTTP failures to typed ScrapeErrors.
 */
async function request(
  path: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  accept: string,
  xhr = false,
): Promise<GenovesaResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    let url = path.startsWith('http') ? path : `${BASE_URL}${path}`;
    for (let hop = 0; hop < 8; hop++) {
      const headers: Record<string, string> = {
        'User-Agent': USER_AGENT,
        Accept: accept,
        'Accept-Language': 'es-AR,es;q=0.9',
      };
      // Only flag the JSON resolver as AJAX; page loads must look like normal
      // navigations or ASP.NET may answer with partials/odd redirects.
      if (xhr) headers['X-Requested-With'] = 'XMLHttpRequest';
      const ck = cookieHeader();
      if (ck) headers.Cookie = ck;

      const res = await fetch(url, { headers, redirect: 'manual', signal: controller.signal });
      storeCookies(res);

      if (res.status === 429) {
        throw new ScrapeError('rate_limited', 'La Genovesa rate-limited the request', { httpStatus: 429 });
      }
      if (res.status >= 500) {
        throw new ScrapeError('site_server_error', `La Genovesa returned HTTP ${res.status}`, {
          httpStatus: res.status,
        });
      }
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) return { status: res.status, finalUrl: url, body: await res.text() };
        url = new URL(loc, url).toString();
        continue;
      }
      return { status: res.status, finalUrl: url, body: await res.text() };
    }
    throw new ScrapeError('network_error', 'La Genovesa: too many redirects');
  } catch (err: unknown) {
    if (err instanceof ScrapeError) throw err;
    if ((err as { name?: string }).name === 'AbortError') {
      throw new ScrapeError('network_timeout', `La Genovesa request timed out after ${timeoutMs}ms`, {
        cause: err,
      });
    }
    throw new ScrapeError('network_error', `La Genovesa request failed: ${describeFetchError(err)}`, {
      cause: err,
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Warm the cookie jar with a session cookie (a GET to /Home) before browsing. */
async function ensureSession(signal: AbortSignal | undefined): Promise<void> {
  if (sessionReady && cookieJar.size > 0) return;
  await request('/Home', signal, REQUEST_TIMEOUT_MS, 'text/html');
  sessionReady = true;
}

/** Forget the current session so the next request re-bootstraps it. */
function resetSession(): void {
  sessionReady = false;
  cookieJar.clear();
}

/** A response that landed back on the Home/location gate (no product). */
function bouncedToHome(r: GenovesaResponse): boolean {
  return /\/Home\b/i.test(r.finalUrl);
}

// =============================================================================
// Parsing helpers
// =============================================================================

/** Parse an es-AR money string ("$ 5.150,00") into a number (5150.0). */
function parseArs(raw: string): number {
  const cleaned = raw.replace(/[^\d.,]/g, '').replace(/\./g, '').replace(',', '.');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

/** Decode the few HTML entities the site leaves in names. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&aacute;/gi, 'á')
    .replace(/&eacute;/gi, 'é')
    .replace(/&iacute;/gi, 'í')
    .replace(/&oacute;/gi, 'ó')
    .replace(/&uacute;/gi, 'ú')
    .replace(/&ntilde;/gi, 'ñ')
    .trim();
}

// Main-product CSS hooks on the DetalleProducto page.
const NAME_RE = /class=["'][^"']*\btitulo\b[^"']*["'][^>]*>\s*([^<]+?)\s*<\/p>/i;
const EAN_RE = /\btextDescripcionDetalle\b[^"']*["'][^>]*>\s*(\d{8,14})\s*</i;
const PRICE_RE =
  /class=["'][^"']*\btextPrecioUnitario\b[^"']*["'][^>]*>\s*\$?\s*([\d.]+,\d{2})/i;
const UNIT_RE = /\(\s*\$?\s*([\d.]+,\d{2})\s*x\s*([\d.,]+)\s*([A-Za-z]+)\s*\)/i;
const OUT_OF_STOCK_RE = /sin\s+stock|no\s+disponible|agotado/i;

/** Build a ScrapeResult by parsing the DetalleProducto HTML. */
export function parseLaGenovesaHtml(
  html: string,
  ctx: Pick<ScrapeContext, 'externalId' | 'externalUrl'>,
): ScrapeResult {
  const priceM = html.match(PRICE_RE);
  const price = priceM?.[1] ? parseArs(priceM[1]) : NaN;
  if (!Number.isFinite(price) || price <= 0) {
    throw new ScrapeError('price_missing', 'La Genovesa product has no usable price');
  }

  const inStock = !OUT_OF_STOCK_RE.test(html);
  const currency = 'ARS';

  const productInfo: ProductInfo = {};
  const nameM = html.match(NAME_RE);
  if (nameM?.[1]) productInfo.name = decodeEntities(nameM[1]);
  const eanM = html.match(EAN_RE);
  if (eanM?.[1]) {
    productInfo.ean = eanM[1];
    productInfo.imageUrl = `${BASE_URL}/Images/Productos/L/${eanM[1]}.jpg`;
  }

  const result: ScrapeResult = {
    price,
    inStock,
    currency,
    tierUsed: 'html',
    promotions: [] as Promotion[],
    productInfo,
    rawData: { externalId: ctx.externalId },
  };

  // Per-unit reference price (e.g. "$1645,00 x 1000 ml").
  const unitM = html.match(UNIT_RE);
  if (unitM?.[1]) {
    const unitPrice = parseArs(unitM[1]);
    if (Number.isFinite(unitPrice)) {
      result.unitPrice = unitPrice;
      result.unitPricePer = `${unitM[2] ?? ''} ${unitM[3] ?? ''}`.trim();
    }
  }

  return result;
}

// =============================================================================
// URL / external_id helpers
// =============================================================================

interface ProductKey {
  articuloId: string;
  tipo: string;
  presId: string;
  promId: string;
}

/** Build the canonical, user-facing product URL from the identifying params. */
function buildCanonicalUrl(k: ProductKey): string {
  return (
    `${BASE_URL}/DetalleProducto?ArticuloID=${encodeURIComponent(k.articuloId)}` +
    `&Tipo=${encodeURIComponent(k.tipo)}` +
    `&PromID=${encodeURIComponent(k.promId)}` +
    `&PresID=${encodeURIComponent(k.presId)}`
  );
}

/** Pack the identifying params into a single external_id string. */
function keyToExternalId(k: ProductKey): string {
  return `${k.articuloId}_${k.tipo}_${k.presId}_${k.promId}`;
}

/** Unpack an external_id back into its parts. */
function externalIdToKey(externalId: string): ProductKey {
  const [articuloId, tipo, presId, promId] = externalId.split('_');
  if (!articuloId || !tipo) {
    throw new ScrapeError('product_not_found', `La Genovesa external_id malformed: "${externalId}"`);
  }
  return { articuloId, tipo, presId: presId ?? '', promId: promId ?? '0' };
}

/** Read the 4 identifying params out of a DetalleProducto URL. */
function keyFromUrl(url: string): ProductKey | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const q = parsed.searchParams;
  const articuloId = q.get('ArticuloID');
  const tipo = q.get('Tipo');
  if (!articuloId || !tipo) return null;
  return {
    articuloId,
    tipo,
    presId: q.get('PresID') ?? '',
    promId: q.get('PromID') ?? '0',
  };
}

function canonicalizeUrl(raw: string): string {
  const k = keyFromUrl(raw);
  // If it isn't a recognizable product URL, just normalize the host.
  if (!k) {
    try {
      const u = new URL(raw);
      u.protocol = 'https:';
      u.host = 'www.lagenovesadigital.com.ar';
      return u.toString();
    } catch {
      return raw;
    }
  }
  return buildCanonicalUrl(k);
}

async function resolveExternalId(canonicalUrl: string): Promise<string> {
  const k = keyFromUrl(canonicalUrl);
  if (!k) {
    throw new ScrapeError('parse_failed', `La Genovesa URL is not a product page: ${canonicalUrl}`);
  }
  return keyToExternalId(k);
}

// =============================================================================
// Adapter methods
// =============================================================================

/** Fetch the DetalleProducto HTML for a product key, refreshing session once. */
async function fetchDetalleHtml(k: ProductKey, signal: AbortSignal | undefined): Promise<string> {
  const path =
    `/DetalleProducto?ArticuloID=${encodeURIComponent(k.articuloId)}` +
    `&PromID=${encodeURIComponent(k.promId)}` +
    `&Tipo=${encodeURIComponent(k.tipo)}` +
    `&ClienteID=${GUEST_CLIENTE_ID}` +
    `&PresID=${encodeURIComponent(k.presId)}` +
    `&IDDom=${DEFAULT_IDDOM}`;

  await ensureSession(signal);
  let res = await request(path, signal, REQUEST_TIMEOUT_MS, 'text/html');
  // A bounce to /Home means our session went stale — refresh once and retry.
  if (bouncedToHome(res)) {
    resetSession();
    await ensureSession(signal);
    res = await request(path, signal, REQUEST_TIMEOUT_MS, 'text/html');
    if (bouncedToHome(res)) {
      throw new ScrapeError('product_not_found', 'La Genovesa bounced to Home (product unavailable)');
    }
  }
  if (res.status === 404) {
    throw new ScrapeError('product_not_found', 'La Genovesa product not found (404)');
  }
  return res.body;
}

async function scrape(ctx: ScrapeContext): Promise<ScrapeResult> {
  const id = ctx.externalId?.trim();
  if (!id) {
    throw new ScrapeError('product_not_found', 'La Genovesa scrape called without an external_id');
  }
  const html = await fetchDetalleHtml(externalIdToKey(id), ctx.signal);
  return parseLaGenovesaHtml(html, ctx);
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
 * EAN discovery via the barcode-scanner resolver (/LectorQR ObtenerArticuloID).
 * Returns the canonical product URL + pre-resolved external_id, or null when
 * La Genovesa doesn't carry the EAN.
 */
async function searchByEan(ean: string, signal?: AbortSignal): Promise<EanSearchResult | null> {
  const digits = ean.replace(/\D/g, '');
  if (!digits) return null;

  const path = `/LectorQR/?handler=ObtenerArticuloID&SCANNER=${encodeURIComponent(digits)}`;
  await ensureSession(signal);
  let res = await request(path, signal, SEARCH_TIMEOUT_MS, 'application/json', true);
  // If the session lapsed the resolver bounces to Home — refresh once.
  if (bouncedToHome(res)) {
    resetSession();
    await ensureSession(signal);
    res = await request(path, signal, SEARCH_TIMEOUT_MS, 'application/json', true);
  }
  if (res.status >= 400 || bouncedToHome(res)) return null;

  let data: ObtenerArticuloResult | null = null;
  try {
    data = JSON.parse(res.body) as ObtenerArticuloResult;
  } catch {
    return null;
  }
  // Only `msj === "OK"` is a hit; misses come back as a SQL/exception object.
  if (!data || data.msj !== 'OK' || data.articulo == null) return null;

  const k: ProductKey = {
    articuloId: String(data.articulo),
    tipo: String(data.tipo ?? ''),
    presId: String(data.idpres ?? ''),
    promId: String(data.promo ?? '0'),
  };
  return { url: buildCanonicalUrl(k), externalId: keyToExternalId(k) };
}

export const laGenovesaAdapter: SupermarketAdapter = {
  id: 'la-genovesa',
  name: 'La Genovesa',
  canonicalizeUrl,
  resolveExternalId,
  scrape,
  probe,
  searchByEan,
};

export { GENOVESA_HOST };
