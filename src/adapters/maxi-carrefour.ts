/**
 * Carrefour Maxi Pedido adapter (`comerciante.carrefour.com.ar`).
 *
 * NOT a VTEX storefront — this is a custom PHP app for Carrefour's wholesale
 * "comerciante" portal. The catalog endpoint is:
 *
 *   GET https://comerciante.carrefour.com.ar/products
 *       ?currentUrl=p/<EAN>&method=getProductBasicData
 *
 * IMPORTANT: `currentUrl=p/...` has NO leading slash. With a leading slash
 * (`currentUrl=/p/...`) the server silently ignores the parameter and
 * returns a generic page of recommendations — same first cart_button for
 * every EAN, which made every probe save the wrong product metadata.
 *
 * It returns an HTML *fragment* (not JSON, not a full page) with all metadata
 * baked into `data-*` attributes on the cart button:
 *
 *   <div class="cart_button"
 *        data-ean="42277071"
 *        data-description="..."
 *        data-price="private"|"<number>"
 *        data-section="..." data-category="..." ...>
 *
 *   <div class="p_item_card_brand">Nivea</div>
 *   <img class="p_principal_img" src="https://carrefourar.vteximg.com.br/...">
 *   <div id="breadcrumb">Inicio > X > Y > Z</div>
 *
 * Catalog data (name, brand, EAN, image, category) is public — no auth needed.
 *
 * **PRICE IS GATED**: when not logged in, `data-price="private"`. To see real
 * prices we need a `PHPSESSID` cookie tied to a registered seller. The login
 * form is reCAPTCHA-Enterprise-protected, so plain `fetch` can't pass it —
 * but a real Chromium driven by Playwright can. We wire that in as a
 * **self-healing** flow (no cron):
 *
 *   1. Try the fetch with the current cookie (DB config → env fallback).
 *   2. If `data-price === "private"`, call `refreshCookie()` — which spawns
 *      headless Chromium, fills the public "comerciante" registration form
 *      with throwaway data, lets reCAPTCHA Enterprise clear the (real)
 *      browser, harvests the new PHPSESSID, and writes it back to
 *      `supermarkets.config.phpSessId` so the next worker picks it up.
 *   3. Retry the fetch once. Still private? → `auth_required` (the login
 *      flow itself is broken — DOM changed, score too low, etc.).
 *
 * The cookie is only refreshed when the site rejects us. If it stays valid
 * for two weeks, we don't log in for two weeks.
 *
 * URL pattern: `/p/<EAN>` — the path component is exactly the product EAN-13.
 * `external_id` is the EAN.
 */

import { ScrapeError } from '../shared/errors.js';
import {
  loadCookieFromConfig,
  refreshCookie,
} from './maxi-carrefour-auth.js';
import type {
  ProductInfo,
  Promotion,
  ScrapeContext,
  ScrapeResult,
  SupermarketAdapter,
} from './types.js';
import type { Logger } from '../shared/logger.js';

const REQUEST_TIMEOUT_MS = 20_000;
const HOST = 'comerciante.carrefour.com.ar';
const BASE = `https://${HOST}`;

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

/** Extract the EAN from `/p/<EAN>` paths. */
function extractEanFromUrl(canonicalUrl: string): string | null {
  try {
    const path = new URL(canonicalUrl).pathname;
    const m = path.match(/^\/p\/([0-9A-Za-z._-]+)$/);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

// =============================================================================
// HTTP layer
// =============================================================================

async function fetchMaxiCarrefourFragment(
  url: string,
  cookie: string | undefined,
  signal: AbortSignal | undefined,
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  if (signal) {
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  const headers: Record<string, string> = {
    'User-Agent': USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,*/*',
    'Accept-Language': 'es-AR,es;q=0.9',
    Referer: BASE,
    'X-Requested-With': 'XMLHttpRequest',
  };
  if (cookie) headers['Cookie'] = `PHPSESSID=${cookie}`;

  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new ScrapeError(
        'network_timeout',
        `Maxi Carrefour request timed out after ${REQUEST_TIMEOUT_MS}ms`,
        { cause: err },
      );
    }
    throw new ScrapeError(
      'network_error',
      `Maxi Carrefour request failed: ${(err as Error).message}`,
      { cause: err },
    );
  } finally {
    clearTimeout(timeoutId);
  }

  if (res.status === 429) {
    throw new ScrapeError('rate_limited', `Maxi Carrefour returned 429`, {
      httpStatus: 429,
    });
  }
  if (res.status >= 500) {
    throw new ScrapeError(
      'site_server_error',
      `Maxi Carrefour returned ${res.status}`,
      { httpStatus: res.status },
    );
  }
  if (!res.ok) {
    throw new ScrapeError(
      'unknown',
      `Maxi Carrefour returned unexpected status ${res.status}`,
      { httpStatus: res.status },
    );
  }
  const text = await res.text();
  // Empty body = product not found (the PHP backend emits empty when EAN is
  // unknown rather than a 404).
  if (text.trim().length === 0) {
    throw new ScrapeError(
      'product_not_found',
      `Maxi Carrefour returned empty fragment for ${url}`,
    );
  }
  return text;
}

// =============================================================================
// HTML extraction helpers
// =============================================================================

/** Read a `data-*` attribute off the cart button (the most reliable element). */
function readCartButtonAttr(html: string, attr: string): string | undefined {
  // The `cart_button` block is the first one in the fragment.
  const blockMatch = html.match(
    /<(?:div|button)\b[^>]*class=["'][^"']*\bcart_button\b[^"']*["'][^>]*>/i,
  );
  if (!blockMatch) return undefined;
  const tag = blockMatch[0];
  const re = new RegExp(`\\b${attr}=["']([^"']*)["']`, 'i');
  return tag.match(re)?.[1];
}

/** Get the first inner text matching `<… class="<className>">…</…>`. */
function readClassText(html: string, className: string): string | undefined {
  const re = new RegExp(
    `<[^>]*class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>\\s*([^<]+?)\\s*<`,
    'i',
  );
  return html.match(re)?.[1]?.trim();
}

/**
 * Parse the cart-button `data-price` attribute into a number.
 *
 * Real-world examples we've seen:
 *   "13887"       — bare integer pesos (most common)
 *   "13887.50"    — period decimal
 *   "13,887.00"   — US-style: comma thousands, period decimal
 *   "13.887,00"   — Argentine: period thousands, comma decimal
 *
 * Strategy: pick the rightmost separator as the decimal separator, treat any
 * other separator characters as noise.
 */
export function parseMaxiCarrefourPrice(raw: string): number {
  const trimmed = raw.trim();
  // Find the rightmost "." or ","
  const lastDot = trimmed.lastIndexOf('.');
  const lastComma = trimmed.lastIndexOf(',');
  let normalized: string;
  if (lastDot === -1 && lastComma === -1) {
    normalized = trimmed;
  } else {
    const decimalIdx = Math.max(lastDot, lastComma);
    const intPart = trimmed.slice(0, decimalIdx).replace(/[.,\s]/g, '');
    const fracPart = trimmed.slice(decimalIdx + 1);
    normalized = `${intPart}.${fracPart}`;
  }
  const n = Number(normalized);
  return n;
}

function readImage(html: string): string | undefined {
  const m = html.match(
    /<img\b[^>]*class=["'][^"']*\bp_principal_img\b[^"']*["'][^>]*\bsrc=["']([^"']+)["']/i,
  );
  return m?.[1];
}

function readBreadcrumb(html: string): string | undefined {
  const m = html.match(
    /<[^>]*\bid=["']breadcrumb["'][^>]*>([\s\S]*?)<\/[^>]+>/i,
  );
  if (!m?.[1]) return undefined;
  // Strip inner tags, keep ">" separators.
  return m[1]
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract everything we know about the product from the catalog fragment.
 *
 * This works whether `data-price` is "private" or a real number — the rest
 * of the metadata (description, brand, EAN, image, breadcrumb) is always
 * populated server-side. Used by both `probe()` (price-agnostic, fast)
 * and `parseMaxiCarrefourFragment()` (price-aware, slow path).
 *
 * @param html        The fragment body from `getProductBasicData`.
 * @param externalId  The EAN we were asked to scrape, used to prefer the
 *                    URL EAN over any internal one. May be empty/undefined.
 */
function extractProductInfo(html: string, externalId?: string): ProductInfo {
  const description = readCartButtonAttr(html, 'data-description');
  const internalEan = readCartButtonAttr(html, 'data-ean');
  const sector = readCartButtonAttr(html, 'data-sector');
  const section = readCartButtonAttr(html, 'data-section');
  const categoryAttr = readCartButtonAttr(html, 'data-category');

  const productInfo: ProductInfo = {};
  if (description) productInfo.name = description.trim();
  const brand = readClassText(html, 'p_item_card_brand');
  if (brand) productInfo.brand = brand;
  // Prefer the URL/external_id EAN-13; fall back to internal if needed.
  const ean = externalId && /^\d{8,14}$/.test(externalId)
    ? externalId
    : internalEan;
  if (ean) productInfo.ean = ean;
  const category = categoryAttr ?? section ?? sector;
  if (category) productInfo.category = category;
  const imageUrl = readImage(html);
  if (imageUrl) productInfo.imageUrl = imageUrl;

  const metadata: Record<string, unknown> = {};
  const breadcrumb = readBreadcrumb(html);
  if (breadcrumb) metadata.breadcrumb = breadcrumb;
  if (internalEan && internalEan !== ean) metadata.internalEan = internalEan;
  if (sector) metadata.sector = sector;
  if (section) metadata.section = section;
  if (Object.keys(metadata).length > 0) productInfo.metadata = metadata;
  return productInfo;
}

// =============================================================================
// Cookie health canary
// =============================================================================

/**
 * Process-level cache for the canary probe result, so a batch of "private"
 * products in one scrape run doesn't re-probe the canary for each of them.
 * Keyed by cookie value so a cookie change invalidates it.
 */
let canaryCache: { cookie: string; at: number; alive: boolean } | undefined;
const CANARY_TTL_MS = 60_000;

/**
 * Check whether the current cookie still unlocks prices, by re-probing a
 * "canary" EAN that was confirmed stocked at the pinned sucursal when the
 * cookie was seeded. Used to tell a dead cookie (→ auth_required, re-seed)
 * apart from a product that simply isn't carried at the pinned sucursal
 * (→ product_not_found). Result is cached briefly (see canaryCache).
 */
async function isCookieAlive(
  cookie: string,
  canaryEan: string,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  if (
    canaryCache &&
    canaryCache.cookie === cookie &&
    Date.now() - canaryCache.at < CANARY_TTL_MS
  ) {
    return canaryCache.alive;
  }
  const url = `${BASE}/products?currentUrl=p/${encodeURIComponent(
    canaryEan,
  )}&method=getProductBasicData`;
  let alive = false;
  try {
    const html = await fetchMaxiCarrefourFragment(url, cookie, signal);
    const price = readCartButtonAttr(html, 'data-price');
    alive = Boolean(price && price !== 'private' && price !== '');
  } catch {
    alive = false;
  }
  canaryCache = { cookie, at: Date.now(), alive };
  return alive;
}

/** Read `maxiCarrefourLogin.autoLogin` (default false — see scrape() notes). */
function isAutoLoginEnabled(config: Record<string, unknown> | undefined): boolean {
  const login = config?.['maxiCarrefourLogin'];
  if (login && typeof login === 'object' && !Array.isArray(login)) {
    return (login as { autoLogin?: boolean }).autoLogin === true;
  }
  return false;
}

// =============================================================================
// Adapter
// =============================================================================

export const maxiCarrefourAdapter: SupermarketAdapter = {
  id: 'maxi-carrefour',
  name: 'Carrefour Maxi Pedido',

  canonicalizeUrl,

  searchByEan(ean: string) {
    // Maxi Carrefour URLs are literally /p/<EAN> — no search API needed.
    // We probe the catalog to confirm the product exists before returning.
    const url = `${BASE}/products?currentUrl=p/${encodeURIComponent(ean)}&method=getProductBasicData`;
    return fetchMaxiCarrefourFragment(url, undefined, undefined)
      .then((html) => {
        const desc = readCartButtonAttr(html, 'data-description');
        // externalId = the EAN itself (that's how this adapter works)
        return desc ? { url: `${BASE}/p/${ean}`, externalId: ean } : null;
      })
      .catch(() => null);
  },

  async resolveExternalId(canonicalUrl: string): Promise<string> {
    const ean = extractEanFromUrl(canonicalUrl);
    if (!ean) {
      throw new ScrapeError(
        'unknown',
        `Maxi Carrefour URL doesn't match /p/<EAN>: ${canonicalUrl}`,
      );
    }
    return ean;
  },

  /**
   * Lightweight probe for the API ingest path — extracts product metadata
   * from the public fragment (which is fully populated even when prices
   * are gated). MUST NOT trigger Playwright; that's reserved for the
   * worker's regular scrape() calls where a 4-minute login dance is fine.
   *
   * IMPORTANT: probe deliberately fetches WITHOUT a cookie. A persisted
   * PHPSESSID is bound to a sucursal AND carries last-viewed-product
   * state, which causes consecutive `getProductBasicData` calls to all
   * echo the same product back regardless of the `currentUrl` argument.
   * Catalog metadata is public — no cookie needed — so we punt to the
   * unauthenticated path which always honors the requested EAN.
   *
   * Falls back to a URL-derived EAN if the network call fails for any
   * reason — the daily run will fill in the rest.
   */
  async probe(ctx: ScrapeContext): Promise<ProductInfo> {
    if (!ctx.externalId) return {};
    // No leading slash on `currentUrl` — see file header for why.
    const url = `${BASE}/products?currentUrl=p/${encodeURIComponent(
      ctx.externalId,
    )}&method=getProductBasicData`;
    try {
      const html = await fetchMaxiCarrefourFragment(url, undefined, ctx.signal);
      return extractProductInfo(html, ctx.externalId);
    } catch (err) {
      (ctx.logger as Logger).info(
        { err: (err as Error).message, externalId: ctx.externalId },
        'maxi-carrefour: probe failed, seeding row with EAN only',
      );
      return /^\d{8,14}$/.test(ctx.externalId) ? { ean: ctx.externalId } : {};
    }
  },

  async scrape(ctx: ScrapeContext): Promise<ScrapeResult> {
    if (!ctx.externalId) {
      throw new ScrapeError(
        'unknown',
        `Maxi Carrefour adapter requires external_id (EAN), got empty.`,
      );
    }
    // No leading slash on `currentUrl` — with one the server ignores the
    // param and returns generic recommendations. See file header.
    const url = `${BASE}/products?currentUrl=p/${encodeURIComponent(
      ctx.externalId,
    )}&method=getProductBasicData`;

    // -- Attempt 1: use whatever cookie is already configured (DB → env). ---
    let cookie = loadCookieFromConfig(ctx.config.config);
    ctx.logger.debug({ url, hasSession: Boolean(cookie) }, 'fetching Maxi Carrefour fragment');
    let html = await fetchMaxiCarrefourFragment(url, cookie, ctx.signal);
    let parsed = parseMaxiCarrefourFragment(html, ctx, {
      hasSession: Boolean(cookie),
      throwOnPrivate: false,
    });
    if (parsed.kind === 'ok') return parsed.result;

    // data-price="private" → the cookie didn't expose a price for THIS
    // product. Two possible reasons:
    //   (a) the product isn't stocked at the pinned sucursal, or
    //   (b) the cookie expired / isn't bound to a seller.
    //
    // We used to resolve this with a headless Playwright re-login right here.
    // But reCAPTCHA Enterprise scores our EC2 headless browser too low to
    // EVER activate a session — verified empirically: local *headed* Edge
    // harvests a working cookie, the SAME code headless on EC2 returns
    // data-price="private" for everything. A headless re-login on the server
    // therefore can't recover, and worse, it would overwrite the good cookie
    // (seeded locally) with a dead one. So on the server we DON'T auto-login.
    //
    // Auto-login remains available behind an explicit opt-in
    // (`maxiCarrefourLogin.autoLogin = true`) for environments with a real
    // headed browser.
    if (!isAutoLoginEnabled(ctx.config.config)) {
      const canaryEan =
        typeof ctx.config.config?.['canaryEan'] === 'string'
          ? (ctx.config.config['canaryEan'] as string)
          : undefined;

      // No cookie configured at all → clearly an auth problem.
      if (!cookie) {
        throw new ScrapeError(
          'auth_required',
          `Maxi Carrefour: no PHPSESSID configured. Seed one locally: ` +
            `npx tsx --env-file=.env scripts/maxi-carrefour-login.ts --edge --headed "--probe=<eans>"`,
        );
      }

      // Canary present → disambiguate dead-cookie vs not-stocked.
      if (canaryEan && canaryEan !== ctx.externalId) {
        const alive = await isCookieAlive(cookie, canaryEan, ctx.signal);
        if (alive) {
          throw new ScrapeError(
            'product_not_found',
            `Maxi Carrefour: data-price="private" but cookie is alive ` +
              `(canary ${canaryEan} unlocks) — product not stocked at the ` +
              `pinned sucursal (ean=${ctx.externalId}).`,
          );
        }
        throw new ScrapeError(
          'auth_required',
          `Maxi Carrefour: cookie expired/invalid (canary ${canaryEan} also ` +
            `returns private). Re-seed locally: npx tsx --env-file=.env ` +
            `scripts/maxi-carrefour-login.ts --edge --headed "--probe=<eans>"`,
        );
      }

      // No canary to test (e.g. cookie seeded before canary support). Assume
      // not-stocked to avoid spurious auth alerts on every missing product;
      // a fully-dead cookie will surface as Maxi producing zero new prices.
      throw new ScrapeError(
        'product_not_found',
        `Maxi Carrefour: data-price="private" (ean=${ctx.externalId}); no ` +
          `canary configured to confirm cookie health. Re-seed locally to enable ` +
          `accurate expiry detection.`,
      );
    }

    // -- Attempt 2 (opt-in autoLogin only): log in via Playwright and search
    // sucursales for THIS exact EAN. Only reachable in headed/real-browser
    // environments where reCAPTCHA actually clears.
    ctx.logger.info(
      { hadCookie: Boolean(cookie), externalId: ctx.externalId },
      'maxi-carrefour: data-price=private, triggering Playwright relogin',
    );
    const fresh = await refreshCookie(ctx.config, ctx.logger, {
      verifyEan: ctx.externalId,
    });
    cookie = fresh.phpSessId;
    html = await fetchMaxiCarrefourFragment(url, cookie, ctx.signal);
    return parseMaxiCarrefourFragment(html, ctx, {
      hasSession: true,
      throwOnPrivate: true,
    }).result!;
  },
};

// =============================================================================
// Pure parser — split for unit testing against saved fragments.
// =============================================================================

/**
 * Outcome of parsing a fragment.
 *   kind:'ok'      → got a price, returns the full ScrapeResult
 *   kind:'private' → catalog visible but price gated (data-price="private")
 *
 * The caller (adapter.scrape) uses 'private' to trigger an auto-relogin and
 * retry. When `opts.throwOnPrivate` is true, the parser throws auth_required
 * directly instead of returning the sentinel — that's the post-relogin call,
 * where private means "even the fresh cookie didn't unlock prices, give up".
 */
export type ParseOutcome =
  | { kind: 'ok'; result: ScrapeResult }
  | { kind: 'private'; result?: undefined };

export function parseMaxiCarrefourFragment(
  html: string,
  ctx: Pick<ScrapeContext, 'externalId'>,
  opts: { hasSession: boolean; throwOnPrivate?: boolean },
): ParseOutcome {
  const dataPrice = readCartButtonAttr(html, 'data-price');
  if (dataPrice === undefined) {
    throw new ScrapeError(
      'selector_failed',
      `Maxi Carrefour fragment missing cart_button (ean=${ctx.externalId})`,
    );
  }

  // -- Price gating --------------------------------------------------------
  // `data-price="private"` means: catalog visible, price hidden until login.
  if (dataPrice === 'private' || dataPrice === '') {
    if (opts.throwOnPrivate) {
      throw new ScrapeError(
        'auth_required',
        `Maxi Carrefour returned data-price="private" even after a fresh ` +
          `Playwright login (ean=${ctx.externalId}) — login flow is broken ` +
          `or this product is sucursal-restricted. Investigate.`,
      );
    }
    return { kind: 'private' };
  }
  const price = parseMaxiCarrefourPrice(dataPrice);
  if (!Number.isFinite(price) || price <= 0) {
    throw new ScrapeError(
      'price_missing',
      `Maxi Carrefour data-price="${dataPrice}" not parseable (ean=${ctx.externalId})`,
    );
  }

  // -- Catalog data --------------------------------------------------------
  // Same extractor used by `probe()` — the public fragment has full
  // metadata regardless of price gating, so we can keep one source of truth.
  const productInfo = extractProductInfo(html, ctx.externalId);

  // Stock is not exposed on the product fragment for guests; we mark in-stock
  // when the price shows up (Maxi Pedido hides "agotado" items behind a CTA).
  const result: ScrapeResult = {
    price,
    inStock: true,
    currency: 'ARS',
    tierUsed: 'html',
    promotions: [] as Promotion[],
    productInfo,
    rawData: { html: html.length > 8000 ? html.slice(0, 8000) + '…' : html },
  };
  // hasSession is logged for forensics; nothing to gate on at this point.
  void opts.hasSession;
  return { kind: 'ok', result };
}

export const MAXI_CARREFOUR_HOSTNAME = HOST;
