/**
 * Shared headless browser for the MercadoLibre storefront.
 *
 * Since 2026-11-24 the official API no longer lets us read another seller's
 * listing (see docs/CADENAS.md), so the adapter loads Ecomodico's pinned PDP in
 * a real Chromium. Plain fetch and Playwright's headless-shell both land on ML's
 * anti-bot wall; what passes is the full browser in new-headless mode with the
 * "Headless" token stripped from its OWN user agent (a made-up UA whose version
 * disagrees with the client hints gets the login wall).
 *
 * The first page of a context hits a JS interstitial ("Continuar") that sets a
 * bypass cookie and redirects after ~3 s; later pages in the same context skip
 * it. So one browser + context is kept per process and reused across jobs,
 * closed after a short idle period to free memory.
 */

import { chromium, type Browser, type BrowserContext, type LaunchOptions } from 'playwright';
import { ScrapeError } from '../shared/errors.js';
import type { Logger } from '../shared/logger.js';
import { getPlaywrightProxy } from '../shared/proxy.js';
import { isMlBlockPage } from './mercadolibre-pdp.js';

const IDLE_CLOSE_MS = 120_000;
const MAX_CONCURRENT_PAGES = 2;
const NAV_TIMEOUT_MS = 30_000;
/** How long to wait for the priced PDP (interstitial included). */
const READY_TIMEOUT_MS = 25_000;
const POLL_MS = 500;
/**
 * Images are switched off with a Blink flag rather than `context.route()`:
 * routing disables Chromium's HTTP cache, so every page would re-download
 * ~2 MB of scripts through the residential proxy. Don't block scripts or
 * XHR either — the interstitial needs them, and starving the page of them
 * got our IP walled.
 */
const BROWSER_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--lang=es-AR',
  '--blink-settings=imagesEnabled=false',
];

export interface MlPage {
  html: string;
  finalUrl: string;
  /** Whether the JS interstitial had to be cleared on this load. */
  challenged: boolean;
}

let browserPromise: Promise<Browser> | undefined;
let contextPromise: Promise<BrowserContext> | undefined;
let idleTimer: NodeJS.Timeout | undefined;
let activePages = 0;
const waiters: Array<() => void> = [];

/**
 * Launch headless Chromium. Installed Edge/Chrome first (local runs), then the
 * full Playwright Chromium via `channel: 'chromium'` (EC2), and the bundled
 * headless-shell last — that one is usually walled, but it is better than not
 * starting at all.
 */
async function launchBrowser(log: Logger): Promise<Browser> {
  const proxy = getPlaywrightProxy('mercadolibre');
  const base: LaunchOptions = {
    headless: true,
    args: BROWSER_ARGS,
    ...(proxy ? { proxy } : {}),
  };
  let lastErr: unknown;
  for (const channel of ['msedge', 'chrome', 'chromium', undefined]) {
    try {
      const browser = await chromium.launch({ ...base, ...(channel ? { channel } : {}) });
      log.info({ channel: channel ?? 'headless-shell', proxied: Boolean(proxy) }, 'mercadolibre browser launched');
      return browser;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new ScrapeError('unknown', `MercadoLibre: could not launch a browser: ${String(lastErr)}`, {
    cause: lastErr,
  });
}

/** The browser's real UA minus the "Headless" marker, so it matches the client hints. */
async function cleanUserAgent(browser: Browser): Promise<string> {
  const probe = await browser.newPage();
  try {
    const ua = await probe.evaluate(() => navigator.userAgent);
    return ua.replace(/Headless(Chrome|Edg)/g, '$1');
  } finally {
    await probe.close().catch(() => undefined);
  }
}

async function getContext(log: Logger): Promise<BrowserContext> {
  if (!browserPromise) {
    browserPromise = launchBrowser(log).catch((err: unknown) => {
      browserPromise = undefined;
      throw err;
    });
  }
  if (!contextPromise) {
    contextPromise = (async () => {
      const browser = await browserPromise!;
      return browser.newContext({
        locale: 'es-AR',
        timezoneId: 'America/Argentina/Buenos_Aires',
        userAgent: await cleanUserAgent(browser),
        viewport: { width: 1366, height: 900 },
      });
    })().catch((err: unknown) => {
      contextPromise = undefined;
      throw err;
    });
  }
  return contextPromise;
}

/** Drop the context (cookies + proxy connections) so the next load starts clean. */
async function resetContext(): Promise<void> {
  const current = contextPromise;
  contextPromise = undefined;
  if (current) await current.then((c) => c.close()).catch(() => undefined);
}

async function closeAll(): Promise<void> {
  await resetContext();
  const current = browserPromise;
  browserPromise = undefined;
  if (current) await current.then((b) => b.close()).catch(() => undefined);
}

async function acquireSlot(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = undefined;
  }
  if (activePages < MAX_CONCURRENT_PAGES) {
    activePages++;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
}

/** Hand the slot to the next waiter, or start the idle-close countdown. */
function releaseSlot(): void {
  const next = waiters.shift();
  if (next) {
    next();
    return;
  }
  activePages--;
  if (activePages === 0) {
    idleTimer = setTimeout(() => void closeAll(), IDLE_CLOSE_MS);
    idleTimer.unref();
  }
}

/**
 * Load a MercadoLibre PDP and return its rendered HTML once the priced page is
 * up (or the wait runs out — the caller's parser then decides what is missing).
 * Throws `rate_limited` on the anti-bot wall, after resetting the context.
 */
export async function loadMlPage(
  url: string,
  opts: { signal?: AbortSignal; logger: Logger },
): Promise<MlPage> {
  await acquireSlot();
  try {
    const context = await getContext(opts.logger);
    const page = await context.newPage();
    const onAbort = (): void => void page.close().catch(() => undefined);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });

      let challenged = false;
      const deadline = Date.now() + READY_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if ((await page.locator('meta[itemprop="price"]').count()) > 0) break;
        if (page.url().includes('/gz/account-verification')) break;
        const button = page.locator('#continue-button');
        if ((await button.count()) > 0) {
          challenged = true;
          if (await button.isEnabled().catch(() => false)) {
            await button.click({ timeout: 2_000 }).catch(() => undefined);
          }
        }
        await page.waitForTimeout(POLL_MS);
      }

      const html = await page.content();
      const finalUrl = page.url();
      if (isMlBlockPage(html, finalUrl)) {
        await resetContext();
        throw new ScrapeError(
          'rate_limited',
          'MercadoLibre showed its anti-bot wall (login / error page) instead of the product',
        );
      }
      return { html, finalUrl, challenged };
    } catch (err: unknown) {
      if (err instanceof ScrapeError) throw err;
      const name = (err as { name?: string }).name;
      if (opts.signal?.aborted || name === 'TimeoutError') {
        throw new ScrapeError('network_timeout', `MercadoLibre page load timed out: ${String(err)}`, {
          cause: err,
        });
      }
      throw new ScrapeError('network_error', `MercadoLibre page load failed: ${String(err)}`, {
        cause: err,
      });
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
      await page.close().catch(() => undefined);
    }
  } finally {
    releaseSlot();
  }
}

/** Close the shared browser now (scripts call this so the process can exit). */
export async function closeMlBrowser(): Promise<void> {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
  await closeAll();
}
