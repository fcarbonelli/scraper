/**
 * MercadoLibre price fetcher — real-browser PDP read.
 *
 * Why this exists: ML's official API only exposes a price for catalog products
 * that have an active "buy-box winner". For the cheap grocery/cleaning items we
 * track, that field is essentially always null, and the marketplace listings
 * search (`/sites/MLA/search`) is 403-gated for our app. So discovery uses the
 * API (great for EAN→catalog mapping) but PRICING has to come from the public
 * product page, which the site renders with a real winning-offer price.
 *
 * Two obstacles, both handled here:
 *   1. Anti-bot: hitting the PDP from a datacenter / non-AR IP redirects to a
 *      `/gz/account-verification` login wall. Routing the browser through the
 *      Argentine residential proxy (the same one Super Mami / Maxiconsumo use)
 *      makes the page load normally.
 *   2. JS rendering: the price is injected client-side. We drive a headless
 *      Chromium (Playwright) and read the JSON-LD `Product` block, which carries
 *      `offers.price`, `priceCurrency` and `availability`.
 *
 * The browser is launched once and reused across scrapes (one fresh context per
 * product for isolation), so a 200-product daily run pays the launch cost once.
 */

import { chromium, type Browser, type BrowserContext } from 'playwright';
import { ScrapeError } from '../shared/errors.js';
import type { Logger } from '../shared/logger.js';
import { getPlaywrightProxy } from '../shared/proxy.js';

const SITE_HOST = 'www.mercadolibre.com.ar';
const NAV_TIMEOUT_MS = 30_000;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/** Parsed result of a PDP read. */
export interface MlPdpResult {
  price: number;
  currency: string;
  inStock: boolean;
  name?: string;
  imageUrl?: string;
}

// Single shared browser, launched lazily and reused for every scrape.
let browserPromise: Promise<Browser> | undefined;

// Auto-close the browser after a spell of inactivity so the worker doesn't hold
// a headless Chromium open between daily runs (the batch keeps it hot via the
// repeated resets below).
const IDLE_CLOSE_MS = 5 * 60 * 1000;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleIdleClose(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => void closeBrowser(), IDLE_CLOSE_MS);
  idleTimer.unref?.();
}

/**
 * Launch a Chromium, preferring an installed system browser (Edge → Chrome)
 * and falling back to Playwright's bundled build (the only option on a bare
 * Linux EC2 box). The AR residential proxy, when configured, is attached at
 * launch so every page load egresses through Argentina.
 */
async function launchBrowser(logger: Logger): Promise<Browser> {
  const proxy = getPlaywrightProxy('mercadolibre');
  const baseArgs = ['--disable-blink-features=AutomationControlled', '--lang=es-AR'];

  const attempts: Array<Parameters<typeof chromium.launch>[0]> = [
    { headless: true, channel: 'chrome', args: baseArgs, ...(proxy ? { proxy } : {}) },
    { headless: true, args: baseArgs, ...(proxy ? { proxy } : {}) },
  ];

  let lastErr: unknown;
  for (const opts of attempts) {
    try {
      const browser = await chromium.launch(opts);
      logger.info(
        { channel: opts?.channel ?? 'bundled', proxied: Boolean(proxy) },
        'mercadolibre: browser launched',
      );
      // If the browser dies (crash / OOM), drop the cached promise so the next
      // scrape relaunches instead of reusing a dead handle.
      browser.on('disconnected', () => {
        browserPromise = undefined;
      });
      return browser;
    } catch (err) {
      lastErr = err;
      logger.warn(
        { channel: opts?.channel ?? 'bundled', err: (err as Error).message },
        'mercadolibre: browser launch failed, trying next option',
      );
    }
  }
  throw new ScrapeError(
    'site_server_error',
    `MercadoLibre: could not launch Chromium: ${(lastErr as Error)?.message}`,
  );
}

async function getBrowser(logger: Logger): Promise<Browser> {
  if (!browserPromise) browserPromise = launchBrowser(logger);
  try {
    return await browserPromise;
  } catch (err) {
    browserPromise = undefined;
    throw err;
  }
}

/** Close the shared browser (used on idle / worker shutdown / tests). */
export async function closeBrowser(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = undefined;
  }
  if (!browserPromise) return;
  const p = browserPromise;
  browserPromise = undefined;
  try {
    const b = await p;
    await b.close();
  } catch {
    /* already gone */
  }
}

/**
 * Load a catalog PDP and extract price/stock. Throws typed ScrapeErrors:
 *   - rate_limited      → hit the account-verification wall (retry rotates the
 *                         proxy IP and often clears it)
 *   - price_missing     → page loaded but no offer/price present
 *   - network_timeout   → navigation timed out
 */
export async function fetchMlPdp(
  productId: string,
  logger: Logger,
  signal?: AbortSignal,
): Promise<MlPdpResult> {
  const browser = await getBrowser(logger);
  const url = `https://${SITE_HOST}/p/${productId}`;

  let context: BrowserContext | undefined;
  try {
    context = await browser.newContext({
      locale: 'es-AR',
      timezoneId: 'America/Argentina/Buenos_Aires',
      userAgent: USER_AGENT,
      viewport: { width: 1366, height: 900 },
    });
    // Hide the navigator.webdriver flag that bot heuristics look for.
    await context.addInitScript(() => {
      const nav = (globalThis as { navigator?: object }).navigator;
      if (nav) Object.defineProperty(nav, 'webdriver', { get: () => undefined });
    });

    const page = await context.newPage();
    page.setDefaultTimeout(NAV_TIMEOUT_MS);

    // Drop heavy sub-resources we never read: cuts page load time and, more
    // importantly, slashes residential-proxy bandwidth (billed per GB). We keep
    // scripts + XHR since the price is injected client-side.
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (type === 'image' || type === 'media' || type === 'font' || type === 'stylesheet') {
        return route.abort();
      }
      return route.continue();
    });
    if (signal) {
      signal.addEventListener('abort', () => void context?.close().catch(() => undefined), {
        once: true,
      });
    }

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });

    // Anti-bot wall: the whole domain redirects suspicious IPs to a login gate.
    const landed = page.url();
    if (landed.includes('account-verification') || landed.includes('/gz/') || landed.includes('/login')) {
      throw new ScrapeError(
        'rate_limited',
        `MercadoLibre served the account-verification wall for ${productId} ` +
          `(IP flagged — needs an Argentine residential egress).`,
      );
    }

    // Price is injected client-side; wait for the JSON-LD product block to be
    // present in the DOM. `state: 'attached'` is essential — a <script> tag is
    // never "visible", so the default wait would burn the full timeout.
    await page
      .waitForSelector('script[type="application/ld+json"]', {
        state: 'attached',
        timeout: NAV_TIMEOUT_MS,
      })
      .catch(() => undefined);

    interface ParsedPdp {
      price: number;
      currency: string;
      availability: string;
      name?: string;
      image?: string;
    }
    const parsed = await page.evaluate((): ParsedPdp | null => {
      // Structural DOM types only — the project's tsconfig has no DOM lib.
      type El = { textContent: string | null; getAttribute(name: string): string | null };
      type Doc = {
        querySelectorAll(s: string): ArrayLike<El>;
        querySelector(s: string): El | null;
      };
      const doc = (globalThis as { document?: Doc }).document;
      if (!doc) return null;

      // Prefer the JSON-LD Product block (most stable source of price + stock).
      const blocks = doc.querySelectorAll('script[type="application/ld+json"]');
      for (let i = 0; i < blocks.length; i++) {
        const text = blocks[i]?.textContent;
        if (!text || !text.includes('"offers"')) continue;
        try {
          const json = JSON.parse(text) as {
            name?: string;
            image?: string;
            offers?: { price?: number; priceCurrency?: string; availability?: string };
          };
          const offers = json.offers;
          if (offers && typeof offers.price === 'number') {
            const out: ParsedPdp = {
              price: offers.price,
              currency: offers.priceCurrency ?? 'ARS',
              availability: offers.availability ?? '',
            };
            if (typeof json.name === 'string') out.name = json.name;
            if (typeof json.image === 'string') out.image = json.image;
            return out;
          }
        } catch {
          /* not the block we want */
        }
      }

      // Fallback: the visible price meta tag.
      const metaPrice = doc.querySelector('meta[itemprop="price"]')?.getAttribute('content');
      if (metaPrice) {
        const out: ParsedPdp = { price: Number(metaPrice), currency: 'ARS', availability: '' };
        const name = doc.querySelector('h1')?.textContent;
        if (name) out.name = name;
        return out;
      }
      return null;
    });

    // ML reports out-of-stock catalog products as price:0 / availability
    // OutOfStock. The pipeline can't record a snapshot without a positive price,
    // so we surface a clear "out of stock" price_missing (vs. a parse failure).
    if (parsed && (parsed.price <= 0 || /OutOfStock/i.test(parsed.availability))) {
      throw new ScrapeError(
        'price_missing',
        `MercadoLibre ${productId} is out of stock (no active seller offer)`,
      );
    }
    if (!parsed || !Number.isFinite(parsed.price)) {
      throw new ScrapeError(
        'price_missing',
        `MercadoLibre PDP for ${productId} loaded but no offer price was found`,
      );
    }

    const result: MlPdpResult = {
      price: parsed.price,
      currency: parsed.currency || 'ARS',
      // No explicit OutOfStock marker → assume available (an offer price exists).
      inStock: !/OutOfStock/i.test(parsed.availability),
    };
    if (parsed.name) result.name = parsed.name.trim();
    if (parsed.image) result.imageUrl = parsed.image;
    return result;
  } catch (err) {
    if (err instanceof ScrapeError) throw err;
    const name = (err as { name?: string }).name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new ScrapeError('network_timeout', `MercadoLibre PDP ${productId} navigation timed out`, {
        cause: err,
      });
    }
    throw new ScrapeError('network_error', `MercadoLibre PDP ${productId} failed: ${(err as Error).message}`, {
      cause: err,
    });
  } finally {
    if (context) await context.close().catch(() => undefined);
    scheduleIdleClose();
  }
}
