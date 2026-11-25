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
 * bypass cookie and redirects; later pages in the same context skip it. The
 * cookie is bound to the exit IP that earned it, so each context gets its own
 * sticky proxy session (one exit IP for all its connections). One browser +
 * context is kept per process and reused across jobs, closed after a short
 * idle period to free memory.
 */

import { chromium, type Browser, type BrowserContext, type LaunchOptions } from 'playwright';
import { ScrapeError } from '../shared/errors.js';
import type { Logger } from '../shared/logger.js';
import { getPlaywrightProxy, newProxySessionId } from '../shared/proxy.js';
import { isMlBlockPage } from './mercadolibre-pdp.js';

const IDLE_CLOSE_MS = 120_000;
const MAX_CONCURRENT_PAGES = 2;
const NAV_TIMEOUT_MS = 30_000;
/** How long to wait for the priced PDP, interstitial included (slow via proxy). */
const READY_TIMEOUT_MS = 35_000;
const POLL_MS = 500;
/** Sticky proxy session length; a daily run of ~90 products takes minutes. */
const PROXY_SESSION_MINUTES = 30;
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
  title: string;
  /** Whether the JS interstitial showed up on this load. */
  challenged: boolean;
}

/**
 * A browser context plus how many pages are using it. A walled context is
 * marked `stale` and replaced for new loads, but only closed once its
 * in-flight pages finish — closing it outright killed sibling loads.
 */
interface ContextSlot {
  context: Promise<BrowserContext>;
  pages: number;
  stale: boolean;
}

let browserPromise: Promise<Browser> | undefined;
let current: ContextSlot | undefined;
let idleTimer: NodeJS.Timeout | undefined;
let activePages = 0;
const waiters: Array<() => void> = [];

/**
 * Launch headless Chromium. Installed Edge/Chrome first (local runs), then the
 * full Playwright Chromium via `channel: 'chromium'` (EC2), and the bundled
 * headless-shell last — that one is usually walled, but it is better than not
 * starting at all. The proxy is set per context, not here.
 */
async function launchBrowser(log: Logger): Promise<Browser> {
  const base: LaunchOptions = { headless: true, args: BROWSER_ARGS };
  let lastErr: unknown;
  for (const channel of ['msedge', 'chrome', 'chromium', undefined]) {
    try {
      const browser = await chromium.launch({ ...base, ...(channel ? { channel } : {}) });
      log.info({ channel: channel ?? 'headless-shell' }, 'mercadolibre browser launched');
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

function getBrowser(log: Logger): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = launchBrowser(log).catch((err: unknown) => {
      browserPromise = undefined;
      throw err;
    });
  }
  return browserPromise;
}

/** A fresh context with its own sticky proxy session (new exit IP). */
function openContextSlot(log: Logger): ContextSlot {
  const context = (async () => {
    const browser = await getBrowser(log);
    const proxy = getPlaywrightProxy('mercadolibre', {
      stickySession: newProxySessionId(),
      lifetimeMinutes: PROXY_SESSION_MINUTES,
    });
    log.info({ proxied: Boolean(proxy) }, 'mercadolibre browser context opened');
    return browser.newContext({
      locale: 'es-AR',
      timezoneId: 'America/Argentina/Buenos_Aires',
      userAgent: await cleanUserAgent(browser),
      viewport: { width: 1366, height: 900 },
      ...(proxy ? { proxy } : {}),
    });
  })();
  const slot: ContextSlot = { context, pages: 0, stale: false };
  context.catch(() => {
    if (current === slot) current = undefined;
  });
  return slot;
}

function closeSlot(slot: ContextSlot): void {
  void slot.context.then((c) => c.close()).catch(() => undefined);
}

/** Retire the context after an anti-bot wall: new loads get a fresh one. */
function retireSlot(slot: ContextSlot): void {
  slot.stale = true;
  if (current === slot) current = undefined;
  if (slot.pages === 0) closeSlot(slot);
}

async function closeAll(): Promise<void> {
  if (current) {
    closeSlot(current);
    current = undefined;
  }
  const b = browserPromise;
  browserPromise = undefined;
  if (b) await b.then((x) => x.close()).catch(() => undefined);
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
 * Throws `rate_limited` on the anti-bot wall, after retiring the context.
 */
export async function loadMlPage(
  url: string,
  opts: { signal?: AbortSignal; logger: Logger },
): Promise<MlPage> {
  await acquireSlot();
  const slot = current ?? (current = openContextSlot(opts.logger));
  slot.pages++;
  try {
    const context = await slot.context;
    const page = await context.newPage();
    const onAbort = (): void => void page.close().catch(() => undefined);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });

      let challenged = false;
      const deadline = Date.now() + READY_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if ((await page.locator('meta[itemprop="price"]').count()) > 0) break;
        // Login wall and captcha wall never grow a price. Stop at once so a
        // burned exit IP is retired instead of sitting out the full wait, and
        // so the next product opens a fresh sticky session.
        const landed = page.url();
        if (landed.includes('/gz/account-verification') || landed.includes('/captcha/wall')) break;
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
      const title = await page.title().catch(() => '');
      if (isMlBlockPage(html, finalUrl)) {
        retireSlot(slot);
        const path = finalUrl.replace(/^https?:\/\/[^/]+/, '').slice(0, 80);
        throw new ScrapeError(
          'rate_limited',
          `MercadoLibre showed its anti-bot wall instead of the product (landed on ${path})`,
        );
      }
      const stuckOnInterstitial =
        (await page.locator('meta[itemprop="price"]').count()) === 0 &&
        (await page.locator('#continue-button').count()) > 0;
      if (stuckOnInterstitial) {
        retireSlot(slot);
        throw new ScrapeError(
          'rate_limited',
          `MercadoLibre anti-bot interstitial did not clear within ${READY_TIMEOUT_MS / 1000}s`,
        );
      }
      return { html, finalUrl, title, challenged };
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
    slot.pages--;
    if (slot.stale && slot.pages === 0) closeSlot(slot);
    releaseSlot();
  }
}

/** Close the shared browser now (scripts call this so the process can exit). */
export async function closeMlBrowser(): Promise<void> {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
  await closeAll();
}
