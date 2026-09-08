/**
 * Shared browser-fetch helper for promo providers whose JSON API sits behind a
 * WAF that fingerprints the TLS handshake (F5 BIG-IP / JA3) — e.g. Galicia,
 * Macro, Santander. Plain `fetch`/`undici` is rejected outright, but the bank's
 * own SPA calls the same API happily from a real Chrome.
 *
 * The trick: drive a real Chromium (Playwright), navigate to the SPA's origin so
 * the page context is established, then run the API calls **inside the page**
 * via `fetch` (real Chrome JA3 + correct Origin/CORS). We reuse the msedge →
 * chrome → bundled launch fallback from the Maxi Carrefour auth helper.
 *
 * Usage:
 *   await withPageFetcher({ origin, headers, logger }, async (f) => {
 *     const { status, json } = await f.getJson(`${base}/list?page=1`);
 *     …
 *   });
 *
 * This module is deliberately generic (no provider specifics) so Galicia, Macro
 * and Santander adapters can all share it.
 */

import type { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright';
import type { Logger } from '../shared/logger.js';

/** Chromium launch preferences (mirrors maxi-carrefour-auth.ts). */
export interface BrowserLaunchOptions {
  /** Default true. Set false to watch a real window (debugging WAFs). */
  headless?: boolean;
  /** Default true. Prefer installed system Chrome/Edge (better WAF scores). */
  useSystemChrome?: boolean;
  /** Force a specific channel ("chrome" | "msedge"). */
  browserChannel?: 'chrome' | 'msedge';
}

/** An in-page JSON GET result. `status < 0` means the fetch threw (WAF/CORS). */
export interface PageJsonResult {
  status: number;
  json: unknown;
  /** Raw text on parse failure (truncated), for diagnostics. */
  raw?: string;
}

/** A live browser page pinned to one origin, able to run repeated in-page GETs. */
export interface PageFetcher {
  /** Run `fetch(url)` inside the page and parse JSON. Never throws on HTTP/CORS. */
  getJson(url: string, extraHeaders?: Record<string, string>): Promise<PageJsonResult>;
  /** The Playwright page (for providers that need to intercept/scroll). */
  page: Page;
}

export interface WithPageFetcherOptions {
  /** SPA URL to navigate to first (establishes origin + boots any WAF cookie). */
  origin: string;
  /** Default headers sent with every in-page fetch (e.g. custom Accept). */
  headers?: Record<string, string>;
  /** Millis to wait after navigation for the SPA to settle. Default 4000. */
  bootMs?: number;
  /**
   * Capture specific request headers from the app's OWN API calls (e.g. a public
   * `apikey` the SPA injects) and auto-merge them into every {@link PageFetcher}
   * fetch. Values are held in-memory only and never logged — this lets us replay
   * the app's paginated API without hardcoding its client token.
   */
  captureHeaders?: { urlIncludes: string; names: string[] };
  launch?: BrowserLaunchOptions;
  logger: Logger;
  signal?: AbortSignal;
}

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/**
 * Launch Chromium, navigate to `origin`, hand a {@link PageFetcher} to `fn`, and
 * always tear the browser down afterwards. All API traffic runs inside the page
 * so it inherits the real browser's TLS fingerprint (clears JA3 WAFs).
 */
export async function withPageFetcher<T>(
  opts: WithPageFetcherOptions,
  fn: (f: PageFetcher) => Promise<T>,
): Promise<T> {
  const log = opts.logger.child({ scope: 'browserFetch', origin: opts.origin });
  const browser = await launchChromium(opts.launch ?? {}, log);
  let ctx: BrowserContext | undefined;
  try {
    ctx = await browser.newContext({
      locale: 'es-AR',
      timezoneId: 'America/Argentina/Buenos_Aires',
      userAgent: DEFAULT_UA,
      viewport: { width: 1366, height: 900 },
    });
    // Hide the automation flag some WAFs sniff.
    await ctx.addInitScript(() => {
      const nav = (globalThis as { navigator?: object }).navigator;
      if (nav) Object.defineProperty(nav, 'webdriver', { get: () => undefined });
    });

    const page = await ctx.newPage();
    page.setDefaultTimeout(30_000);

    // Capture auth-ish headers (e.g. apikey) from the app's own API calls. Held
    // in-memory only, merged into our fetches, never logged.
    const captured: Record<string, string> = {};
    const cap = opts.captureHeaders;
    if (cap) {
      page.on('request', (req) => {
        if (!req.url().includes(cap.urlIncludes)) return;
        const h = req.headers(); // lowercased keys
        for (const name of cap.names) {
          const v = h[name.toLowerCase()];
          if (typeof v === 'string' && v.length > 0) captured[name] = v;
        }
      });
    }

    log.info('navigating to SPA origin');
    await page.goto(opts.origin, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(opts.bootMs ?? 4000);
    if (opts.signal?.aborted) throw new Error('aborted');

    if (cap && Object.keys(captured).length === 0) {
      // The app may not have fired the target call yet — wait briefly for one.
      await page
        .waitForRequest((r) => r.url().includes(cap.urlIncludes), { timeout: 15_000 })
        .catch(() => undefined);
      await page.waitForTimeout(500);
      if (Object.keys(captured).length > 0) {
        log.debug({ names: Object.keys(captured) }, 'captured app headers');
      } else {
        log.warn({ urlIncludes: cap.urlIncludes }, 'no app headers captured');
      }
    }

    // Merge captured headers under the provided defaults (captured wins).
    const defaultHeaders = { ...(opts.headers ?? {}), ...captured };
    const fetcher: PageFetcher = {
      page,
      async getJson(url, extraHeaders) {
        const headers = { ...defaultHeaders, ...(extraHeaders ?? {}) };
        return page.evaluate(
          async (args: { url: string; headers: Record<string, string> }): Promise<PageJsonResult> => {
            try {
              // Default (same-origin) credentials: cross-origin sends no cookies,
              // which is what these public BFFs expect. `include` breaks CORS
              // unless the server echoes Allow-Credentials — most don't.
              const r = await fetch(args.url, { headers: args.headers });
              const text = await r.text();
              try {
                return { status: r.status, json: JSON.parse(text) };
              } catch {
                return { status: r.status, json: null, raw: text.slice(0, 300) };
              }
            } catch (e) {
              return { status: -1, json: null, raw: (e as Error).message };
            }
          },
          { url, headers },
        );
      },
    };

    return await fn(fetcher);
  } finally {
    if (ctx) await ctx.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

/**
 * Launch Chromium, preferring installed system browsers (Edge → Chrome) over
 * Playwright's bundled build — real browsers score better against bot WAFs.
 */
async function launchChromium(
  launch: BrowserLaunchOptions,
  log: Logger,
): Promise<Browser> {
  const headless = launch.headless ?? true;
  const useSystemChrome = launch.useSystemChrome ?? true;
  const args = ['--disable-blink-features=AutomationControlled', '--lang=es-AR'];

  const attempts: Array<Parameters<typeof chromium.launch>[0]> = [];
  if (launch.browserChannel) {
    attempts.push({ headless, channel: launch.browserChannel, args });
  } else if (useSystemChrome) {
    attempts.push({ headless, channel: 'msedge', args });
    attempts.push({ headless, channel: 'chrome', args });
  }
  attempts.push({ headless, args }); // bundled fallback

  let lastErr: unknown;
  for (const opts of attempts) {
    try {
      const browser = await chromium.launch(opts);
      log.debug({ channel: opts?.channel ?? 'bundled', headless }, 'browser launched');
      return browser;
    } catch (err) {
      lastErr = err;
      log.warn(
        { channel: opts?.channel, err: (err as Error).message },
        'browser launch failed, trying next',
      );
    }
  }
  throw new Error(
    `Could not launch any Chromium variant: ${(lastErr as Error)?.message}`,
  );
}
