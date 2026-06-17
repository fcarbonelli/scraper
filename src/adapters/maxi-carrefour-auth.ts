/**
 * Maxi Carrefour authentication helper — self-healing PHPSESSID rotation.
 *
 * Why this module exists:
 *   `comerciante.carrefour.com.ar` gates prices behind a logged-in session.
 *   The login form is reCAPTCHA-Enterprise-protected, so plain `fetch` calls
 *   can't pass it. To stay automated we drive a real Chromium via Playwright
 *   (which Google trusts enough to clear the invisible reCAPTCHA challenge),
 *   submit the public "comerciante" registration form with throwaway data,
 *   and harvest the resulting PHPSESSID cookie.
 *
 * Lifecycle (no cron — purely on-demand / event-driven):
 *
 *   ┌─ scrape() called ───────────────────────────────────────────────┐
 *   │  1. Try fetch with current cookie (DB config → env fallback).   │
 *   │  2. If `data-price="private"` → call `ensureFreshCookie(ctx,    │
 *   │     {force:true})`.                                              │
 *   │     - First-ever scrape (no cookie yet)? Same path: login, save,│
 *   │       retry.                                                     │
 *   │     - Concurrent scrapes detecting expiry simultaneously share  │
 *   │       a single in-flight login (process-level singleton).       │
 *   │  3. New cookie is persisted to `supermarkets.config.phpSessId`  │
 *   │     so the *next* run starts already valid (and other workers   │
 *   │     pick it up too).                                             │
 *   │  4. Retry the fetch once with the fresh cookie. Still private?  │
 *   │     Throw `auth_required` for human attention (login flow       │
 *   │     itself is broken — DOM changed, reCAPTCHA score too low,    │
 *   │     etc.).                                                       │
 *   └─────────────────────────────────────────────────────────────────┘
 *
 * The cookie is only refreshed when the site actually rejects us. There's no
 * cron, no schedule, no "refresh every N hours". If the cookie keeps working
 * for two weeks, we never log in for two weeks.
 */

import type { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright';
import { env } from '../shared/env.js';
import { ScrapeError } from '../shared/errors.js';
import type { Logger } from '../shared/logger.js';
import type { SupermarketConfig } from './types.js';

const HOST = 'comerciante.carrefour.com.ar';
const HOMEPAGE = `https://${HOST}/`;

// Delivery mode passed to the `sellersLists` endpoint and selected in the
// login wizard's step 2. '0' = "retiro" (pickup at store), '1' = "envio"
// (ship to business). We use retiro: it exposes far more sucursales (e.g.
// CABA returns 9 for retiro vs 2 for envio), maximizing product coverage.
const DELIVERY_TYPE = '0';

// Time budget for the whole login flow. The site can be slow (forms reveal
// step-by-step, reCAPTCHA token fetch round-trips Google), so be generous —
// but bail eventually so a stuck flow doesn't hang the worker.
const LOGIN_TIMEOUT_MS = 120_000;

// =============================================================================
// Cookie resolution from existing config (DB → env fallback)
// =============================================================================

/**
 * Read the currently-stored PHPSESSID from either:
 *   1. `supermarkets.config.phpSessId` (DB, written by `persistCookie` after
 *      every successful auto-login — preferred).
 *   2. `MAXI_CARREFOUR_PHPSESSID` env (operator override / first-run seed).
 * Returns `undefined` if no cookie is configured anywhere.
 */
export function loadCookieFromConfig(
  config: Record<string, unknown> | undefined,
): string | undefined {
  const fromConfig = config?.['phpSessId'];
  if (typeof fromConfig === 'string' && fromConfig.trim() !== '') {
    return fromConfig.trim();
  }
  const fromEnv = env.MAXI_CARREFOUR_PHPSESSID;
  if (fromEnv && fromEnv.trim() !== '') return fromEnv.trim();
  return undefined;
}

// =============================================================================
// Login flow defaults (overridable via supermarkets.config.maxiCarrefourLogin)
// =============================================================================

interface LoginDefaults {
  /**
   * Display name. Client-side validator (registerModal.js) requires length
   * 8-30 chars; server doesn't verify identity.
   */
  name: string;
  /**
   * DNI or CUIT. Validator accepts either:
   *   - 7-8 digit DNI: `/^\d{7,8}$/` (preferred — no checksum to compute)
   *   - 11-digit CUIT with valid Mod-11 verifier digit
   * We default to a DNI to keep this self-contained.
   */
  numberId: string;
  /**
   * Phone. Validator regex: `/^0?(?:\(\d{2,4}\)|\d{2,4})\s?\d{6,10}$/` AND
   * the area code must be in a hard-coded set. "01111111111" works (11 = CABA).
   */
  phone: string;
  /** Email. Format-validated client-side; server doesn't send confirmation. */
  email: string;
  /**
   * Selector strategy for picking region/seller:
   *   "first" — pick the first non-empty option in each dropdown (default).
   *   { region: "...", seller: "..." } — exact <option> values to use.
   */
  pick:
    | 'first'
    | { region?: string; seller?: string };
  /**
   * Sellers to skip when picking. Used by auto-retry: if a login picks
   * seller X and that seller doesn't carry the product we're trying to
   * scrape, the caller logs in again with X added to this list.
   */
  skipSellers?: string[];
  /**
   * Regions to skip — same idea. After exhausting all sellers in a region,
   * the retry loop adds the region here and tries the next region.
   */
  skipRegions?: string[];
}

const DEFAULT_LOGIN: LoginDefaults = {
  name: 'Juan Perez',
  numberId: '30123456',
  phone: '01111111111',
  email: 'price-watch-bot@example.com',
  pick: 'first',
};

// Prefer dense regions first. The site's region dropdown starts with
// "BS AS (NORTE)", but for product coverage CABA is usually a better first
// bet. Anything not listed here keeps the site's original order after these.
const REGION_PRIORITY = [
  'CABA',
  'BS AS (OESTE)',
  'BS AS (NORTE)',
  'BS AS (SUR)',
] as const;

function loadLoginDefaults(
  config: Record<string, unknown> | undefined,
): LoginDefaults {
  const override = config?.['maxiCarrefourLogin'];
  if (override && typeof override === 'object' && !Array.isArray(override)) {
    return { ...DEFAULT_LOGIN, ...(override as Partial<LoginDefaults>) };
  }
  return DEFAULT_LOGIN;
}

// =============================================================================
// Playwright login
// =============================================================================

export interface LoginResult {
  /** Fresh PHPSESSID cookie value (no name= prefix). */
  phpSessId: string;
  /** When the cookie expires according to Set-Cookie, if present. */
  expiresAt?: string;
  /** Region/seller actually used (for forensics). */
  region?: string;
  seller?: string;
}

/**
 * Drive a real Chromium through the public "comerciante" form to get a
 * session-bound PHPSESSID. No DB I/O — pure browser automation.
 *
 * Throws `ScrapeError('auth_required', ...)` if the login flow itself fails
 * (form changed, reCAPTCHA rejected, server didn't issue cookie). The caller
 * is expected to surface this so a human can investigate.
 */
export interface LaunchOptions {
  /**
   * Default `true`. Set to `false` to watch the flow visually (a Chrome
   * window opens). Useful for local debugging when reCAPTCHA is rejecting
   * the headless run — visible Chrome consistently scores higher.
   */
  headless?: boolean;
  /**
   * Default `true`. When true, prefer installed system browsers over
   * Playwright's bundled chromium-headless-shell — reCAPTCHA Enterprise
   * scores real browsers much higher than Playwright's headless build.
   * Set to `false` to fall back to bundled chromium (e.g. on CI machines
   * without a system browser installed).
   */
  useSystemChrome?: boolean;
  /**
   * Optional explicit Chromium channel. Useful for local debugging when
   * reCAPTCHA behaves differently across installed browsers.
   *
   * Examples: "chrome", "msedge".
   */
  browserChannel?: 'chrome' | 'msedge';
}

export async function loginAndGetCookie(
  loginCfg: LoginDefaults,
  logger: Logger,
  launchOpts: LaunchOptions = {},
): Promise<LoginResult> {
  const startedAt = Date.now();
  const headless = launchOpts.headless ?? true;
  const useSystemChrome = launchOpts.useSystemChrome ?? true;
  const browserChannel = launchOpts.browserChannel;

  let browser: Browser | undefined;
  try {
    // Prefer installed system browsers — Playwright's bundled
    // chromium-headless-shell is consistently flagged by reCAPTCHA Enterprise
    // because it ships without a number of fingerprintable browser APIs.
    //
    // Edge is tried before Chrome because Maxi Carrefour's reCAPTCHA flow
    // currently passes in Edge while Chrome/incognito times out for the same
    // form inputs. If Edge isn't installed, we fall through to Chrome and
    // finally bundled Chromium.
    const launchAttempts: Array<Parameters<typeof chromium.launch>[0]> = [];
    if (browserChannel) {
      launchAttempts.push({
        headless,
        channel: browserChannel,
        args: ['--disable-blink-features=AutomationControlled', '--lang=es-AR'],
      });
    } else if (useSystemChrome) {
      launchAttempts.push({
        headless,
        channel: 'msedge',
        args: ['--disable-blink-features=AutomationControlled', '--lang=es-AR'],
      });
      launchAttempts.push({
        headless,
        channel: 'chrome',
        args: ['--disable-blink-features=AutomationControlled', '--lang=es-AR'],
      });
    }
    launchAttempts.push({
      headless,
      args: ['--disable-blink-features=AutomationControlled', '--lang=es-AR'],
    });

    let lastErr: unknown;
    let launchedChannel: string | undefined;
    for (const opts of launchAttempts) {
      try {
        browser = await chromium.launch(opts);
        launchedChannel = opts?.channel;
        logger.debug(
          { channel: opts?.channel ?? 'bundled', headless },
          'maxi-carrefour: browser launched',
        );
        break;
      } catch (err) {
        lastErr = err;
        logger.warn(
          { channel: opts?.channel, err: (err as Error).message },
          'maxi-carrefour: browser launch failed, trying next option',
        );
      }
    }
    if (!browser) {
      throw new ScrapeError(
        'auth_required',
        `Could not launch any Chromium variant: ${(lastErr as Error)?.message}`,
      );
    }

    const contextUserAgent =
      launchedChannel === 'msedge'
        ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0'
        : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

    const ctx: BrowserContext = await browser.newContext({
      locale: 'es-AR',
      timezoneId: 'America/Argentina/Buenos_Aires',
      userAgent: contextUserAgent,
      viewport: { width: 1366, height: 900 },
    });
    // Hide the navigator.webdriver flag — reCAPTCHA's bot heuristics check it.
    // (Init scripts run in browser context; cast to skip Node-side DOM checks.)
    await ctx.addInitScript(() => {
      const nav = (globalThis as { navigator?: object }).navigator;
      if (nav) Object.defineProperty(nav, 'webdriver', { get: () => undefined });
    });

    const page = await ctx.newPage();
    page.setDefaultTimeout(20_000);

    logger.info({ host: HOST }, 'maxi-carrefour: opening homepage');
    await page.goto(HOMEPAGE, { waitUntil: 'domcontentloaded' });

    // The login form (#userForm) is server-rendered into the page, but the
    // sidebar containing it is hidden until "Ingresar" is clicked. The radios
    // and step1/step2 elements exist immediately though, so we can interact
    // without first opening the sidebar — but doing so is more
    // human-like and helps reCAPTCHA score, so we click anyway.
    const ingresarBtn = page.locator(
      'span:has-text("Ingresar"), [onclick*="openLogin"], #ingresar',
    ).first();
    if (await ingresarBtn.count()) {
      await ingresarBtn.click({ trial: false }).catch(() => undefined);
    }

    // ---------------------------------------------------------------------
    // The login modal is a 3-step wizard (the site added step 2 — delivery
    // mode — in mid-2026; before that it was 2 steps):
    //
    //   step1: choose "comerciante" (business) vs "consumidor" (customer).
    //          #business has onclick="goToStep2()".
    //   step2: choose delivery mode — "retiro" (pickup at store) or "envio"
    //          (ship to business). Selecting one enables #btn_step2
    //          ("Siguiente") AND triggers getZoneInfo(deliveryType) which
    //          populates #region. #btn_step2 then calls goToStep3().
    //   step3: province (#region) + sucursal (#seller) + contact fields.
    //          #region/#seller only populate AFTER a delivery mode is picked,
    //          and the contact inputs are display:none until step3 is shown.
    //
    // We use "retiro" (DELIVERY_TYPE='0'): the sellersLists endpoint returns
    // far more sucursales for pickup than for ship (e.g. CABA: 9 vs 2), which
    // maximizes product coverage.
    // ---------------------------------------------------------------------

    // Step 1 → 2: pick "comerciante".
    logger.debug({}, 'maxi-carrefour: step1 → clicking business card');
    await page.locator('#business').click();

    // Step 2: select "retiro" delivery mode. The site's click handler sets the
    // hidden `selected_delivery` input + `delivery` radio (which login.php uses
    // to resolve the sucursal master), enables "Siguiente", and kicks off the
    // region XHR. We click the real card so all of that fires natively.
    logger.debug({}, 'maxi-carrefour: step2 → selecting retiro delivery mode');
    await page.locator('#retiro').click();

    // Advance to step3 so the contact inputs become visible (Playwright's
    // fill() needs visible/editable elements). #btn_step2 only gets its
    // click→goToStep3 handler after a delivery mode is chosen, hence the order.
    logger.debug({}, 'maxi-carrefour: step2 → clicking Siguiente');
    await page.locator('#btn_step2').click();

    // Step 3: pick region (province), then load + pick a seller.
    //
    // We DON'T rely on the site's inline `onchange="onchangeSelect(this)"`
    // handler chain to populate the seller dropdown. That chain is fragile
    // under automation — Playwright's selectOption fires synthetic events
    // that occasionally don't trigger the inline handler, and even when they
    // do, there's a race between the XHR completing and our pick logic.
    // Instead we fetch the seller list ourselves (same endpoint) and inject it.
    //
    // #region is populated by getFilteredZoneInfo(), which fires one
    // sellersLists probe PER zone (~23) to mark zones with no stock as
    // disabled — so it can take a while. Use a generous timeout.
    logger.debug({}, 'maxi-carrefour: step3 → waiting for regions to load');
    await waitForOptions(page, '#region', 40_000);

    logger.debug({}, 'maxi-carrefour: selecting region');
    const region = await pickFirstRealOption(page, '#region', loginCfg, 'region');
    if (!region) {
      throw new ScrapeError(
        'auth_required',
        `Maxi Carrefour: no region available to pick ` +
          `(skipRegions=${(loginCfg.skipRegions ?? []).join(',')}).`,
      );
    }

    logger.debug({ region }, 'maxi-carrefour: fetching sellers via XHR');
    const seller = await fetchAndPickSeller(page, region, loginCfg, logger);
    if (!seller) {
      throw new ScrapeError(
        'auth_required',
        `Maxi Carrefour: no seller available in region ` +
          `"${region}" for retiro (skipSellers=${(loginCfg.skipSellers ?? []).join(',')}).`,
      );
    }

    // Customer info — random throwaway values; nothing here is verified server-
    // side, the form only checks shape.
    logger.debug({ region, seller }, 'maxi-carrefour: filling customer fields');
    await page.fill('#user-name', loginCfg.name);
    await page.fill('#user-cuit', loginCfg.numberId);
    await page.fill('#user-phone', loginCfg.phone);
    await page.fill('#user-email', loginCfg.email);

    // Submit. The site's submit handler:
    //   1. validar() validates fields (returns false → bail).
    //   2. event.preventDefault().
    //   3. grecaptcha.enterprise.execute('signup') → async token fetch.
    //   4. Prepend hidden inputs (token, action) to the form.
    //   5. unbind('submit').submit() to finally POST to /login.
    //   6. Server validates token, sets new PHPSESSID, redirects.
    //
    // So we *must* wait for the actual POST to fly + redirect to land. The
    // simplest way is to wait for the response of the /login request itself.
    logger.info({}, 'maxi-carrefour: submitting login form');
    const beforeCookie = (await ctx.cookies(HOMEPAGE)).find((c) => c.name === 'PHPSESSID')?.value;
    const submitBtn = page
      .locator('#userForm button[type="submit"], #userForm input[type="submit"]')
      .first();
    const loginResponsePromise = page
      .waitForResponse(
        (resp) => resp.url().includes('/login') && resp.request().method() === 'POST',
        { timeout: 60_000 },
      )
      .catch(() => undefined);
    if (await submitBtn.count()) {
      await submitBtn.click();
    } else {
      // Fall back to firing the form-submit event programmatically.
      await page.evaluate(() => {
        type Form = { requestSubmit?: () => void; submit?: () => void } | null;
        const form = (globalThis as { document?: { querySelector(s: string): unknown } })
          .document?.querySelector('#userForm') as Form;
        if (form?.requestSubmit) form.requestSubmit();
        else if (form?.submit) form.submit();
      });
    }
    const loginResponse = await loginResponsePromise;
    if (!loginResponse) {
      throw new ScrapeError(
        'auth_required',
        `Maxi Carrefour: /login POST never fired — reCAPTCHA likely rejected, ` +
          `validar() failed, or DOM changed.`,
      );
    }
    logger.debug(
      { status: loginResponse.status(), url: loginResponse.url() },
      'maxi-carrefour: /login responded',
    );
    // Wait for the post-login redirect chain to settle. The form POST → /login
    // returns a 302 to (typically) the catalog homepage, which itself loads
    // assets. We don't want to race that with our cookie harvest.
    await page
      .waitForLoadState('networkidle', { timeout: 20_000 })
      .catch(() => undefined);

    // Harvest the PHPSESSID cookie from the browser context.
    const cookies = await ctx.cookies(HOMEPAGE);
    const phpSess = cookies.find((c) => c.name === 'PHPSESSID');
    if (!phpSess?.value) {
      throw new ScrapeError(
        'auth_required',
        `Maxi Carrefour login completed but no PHPSESSID cookie was set.`,
      );
    }
    if (beforeCookie && beforeCookie === phpSess.value) {
      // PHP can re-use the session id (mod_session sets it on first homepage
      // hit and just upgrades flags on login). That's not a failure on its
      // own — verifyCookieUnlocksPrices below is the real signal.
      logger.debug(
        { cookieRetained: true },
        'maxi-carrefour: same PHPSESSID after login (server upgraded existing session)',
      );
    }

    // We don't verify the cookie here. Verification happens naturally in
    // the outer adapter flow: scrape() retries the actual product fetch with
    // the fresh cookie and throws `auth_required` if it's still "private".
    // That's both more reliable (per-product) and avoids extra HTTP round-
    // trips when the cookie works (the common case).

    const elapsedMs = Date.now() - startedAt;
    logger.info(
      { elapsedMs, region, seller, expires: phpSess.expires },
      'maxi-carrefour: login OK, cookie harvested',
    );
    const result: LoginResult = { phpSessId: phpSess.value };
    if (region) result.region = region;
    if (seller) result.seller = seller;
    if (phpSess.expires && phpSess.expires > 0) {
      result.expiresAt = new Date(phpSess.expires * 1000).toISOString();
    }
    return result;
  } catch (err) {
    if (err instanceof ScrapeError) throw err;
    throw new ScrapeError(
      'auth_required',
      `Maxi Carrefour login failed: ${(err as Error).message}`,
      { cause: err },
    );
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}

/**
 * Wait until a `<select>` has at least one option with a non-empty `value`
 * attribute (i.e. a real choice, not just the placeholder).
 *
 * The site populates #region and #seller asynchronously via XHR, so we
 * can't pick an option until the response has landed.
 */
async function waitForOptions(
  page: Page,
  selector: string,
  timeoutMs: number,
): Promise<void> {
  await page.waitForFunction(
    (sel: string): boolean => {
      type Sel = { options: ArrayLike<{ value: string }> } | null;
      const el = (globalThis as { document?: { querySelector(s: string): unknown } })
        .document?.querySelector(sel) as Sel;
      if (!el) return false;
      for (let i = 0; i < el.options.length; i++) {
        const o = el.options[i];
        if (o && o.value && o.value !== '') return true;
      }
      return false;
    },
    selector,
    { timeout: timeoutMs },
  );
}

/**
 * Pick the first non-placeholder option of a `<select>`, honoring an exact
 * override from the login config when provided. Returns the chosen value
 * (or undefined if no real option exists yet — the caller should
 * `waitForOptions` first to ensure the dropdown is populated).
 *
 * `skipValues` lets the retry loop avoid sellers/regions already known to
 * not carry the target product.
 *
 * Used for #region only — the seller dropdown is now populated by
 * `fetchAndPickSeller` to bypass the fragile inline-onchange dependency.
 */
async function pickFirstRealOption(
  page: Page,
  selector: string,
  cfg: LoginDefaults,
  field: 'region' | 'seller',
): Promise<string | undefined> {
  // 1. Honor an explicit override if the operator pinned a region/seller.
  if (cfg.pick !== 'first' && cfg.pick[field]) {
    const exact = cfg.pick[field]!;
    await page.selectOption(selector, exact);
    return exact;
  }

  // 2. Otherwise: pick the first option whose value isn't empty/placeholder
  //    AND isn't in the skip list (used by auto-retry on per-seller misses).
  //    "Placeholder" detection covers value="0"/"-1" and option text
  //    starting with "Seleccion…" or "Elegi…" / "Elija…" — common Spanish
  //    prompt text on the site.
  const skip = field === 'seller' ? cfg.skipSellers ?? [] : cfg.skipRegions ?? [];
  const value = await page.evaluate(
    (args: {
      sel: string;
      skip: string[];
      field: 'region' | 'seller';
      regionPriority: readonly string[];
    }): string | undefined => {
      type Opt = {
        value: string;
        text?: string;
        textContent?: string | null;
        disabled?: boolean;
      };
      type Sel = { options: ArrayLike<Opt> } | null;
      const el = (globalThis as { document?: { querySelector(s: string): unknown } })
        .document?.querySelector(args.sel) as Sel;
      if (!el) return undefined;
      const placeholderText = /^(seleccion|elegi|elija|--)/i;
      const placeholderValues = new Set(['', '0', '-1', 'null', 'undefined']);
      const candidates: Array<{ value: string; index: number }> = [];
      for (let i = 0; i < el.options.length; i++) {
        const o = el.options[i];
        if (!o || !o.value) continue;
        // Skip disabled options. getFilteredZoneInfo() marks zones with no
        // sucursales for the chosen delivery type as disabled.
        if (o.disabled) continue;
        if (placeholderValues.has(o.value)) continue;
        const txt = (o.text ?? o.textContent ?? '').trim();
        if (placeholderText.test(txt)) continue;
        if (args.skip.indexOf(o.value) !== -1) continue;
        candidates.push({ value: o.value, index: i });
      }
      if (args.field !== 'region') return candidates[0]?.value;

      candidates.sort((a, b) => {
        const ai = args.regionPriority.indexOf(a.value);
        const bi = args.regionPriority.indexOf(b.value);
        const ar = ai === -1 ? Number.MAX_SAFE_INTEGER : ai;
        const br = bi === -1 ? Number.MAX_SAFE_INTEGER : bi;
        return ar === br ? a.index - b.index : ar - br;
      });
      return candidates[0]?.value;
    },
    { sel: selector, skip, field, regionPriority: REGION_PRIORITY },
  );
  if (!value) return undefined;
  await page.selectOption(selector, value);
  return value;
}

/**
 * Fetch the seller list for a region directly via the same XHR endpoint the
 * site uses (`POST /seller?method=sellersLists`), parse it, pick a seller,
 * then inject + select it into #seller.
 *
 * Why this instead of relying on the dropdown's onchange chain:
 *   - The site's `onchange="onchangeSelect(this)"` calls `getSellerList(value)`
 *     which fires the XHR. Under Playwright the synthetic `change` event
 *     occasionally fails to trigger this inline handler, leaving the seller
 *     dropdown empty and the script unable to proceed.
 *   - Even when the handler fires, there's no awaitable signal — we'd have
 *     to poll the DOM for new options, racing with placeholder + partial
 *     responses.
 *   - Doing the XHR ourselves (from page context, so cookies + same-origin
 *     headers are correct) gives us a deterministic Promise we can await,
 *     full visibility into envio="0" sellers (which the site silently
 *     rejects on selection), and a reliable way to pick + commit the value.
 *
 * Returns the chosen seller's value (its numeric ID), or undefined if no
 * seller in this region has delivery (envio="1") and isn't on the skip list.
 */
async function fetchAndPickSeller(
  page: Page,
  region: string,
  cfg: LoginDefaults,
  logger: Logger,
): Promise<string | undefined> {
  // 1. Fetch the raw <option>...</option> HTML the site would inject.
  type FetchResult = { ok: true; html: string } | { ok: false; error: string };
  const fetched = (await page.evaluate(
    async (args: { zone: string; deliveryType: string }): Promise<FetchResult> => {
      type FetchFn = (
        url: string,
        init: { method: string; headers: Record<string, string>; body: string },
      ) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
      const w = globalThis as unknown as {
        fetch: FetchFn;
        location: { origin: string };
      };
      try {
        const res = await w.fetch(`${w.location.origin}/seller?method=sellersLists`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Requested-With': 'XMLHttpRequest',
          },
          body: `zoneId=${encodeURIComponent(args.zone)}&deliveryType=${encodeURIComponent(args.deliveryType)}`,
        });
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        return { ok: true, html: await res.text() };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
    { zone: region, deliveryType: DELIVERY_TYPE },
  )) as FetchResult;
  if (!fetched.ok) {
    throw new ScrapeError(
      'auth_required',
      `Maxi Carrefour: sellersLists XHR failed for region "${region}": ${fetched.error}`,
    );
  }

  // 2. Parse + pick a seller in page context. We pick the first option with
  //    a real numeric value that isn't on the skip list. Operator pin
  //    overrides the search.
  //
  //    Note: the `sellersLists` endpoint now takes a `deliveryType` param and
  //    pre-filters server-side, so EVERY returned option is valid for retiro.
  //    The old `envio="1"` attribute is gone — we no longer filter on it.
  const exactSellerPin =
    cfg.pick !== 'first' && cfg.pick.seller ? cfg.pick.seller : undefined;
  const skipSellers = cfg.skipSellers ?? [];
  type PickResult = { value: string; text: string } | null;
  const picked = (await page.evaluate(
    (args: { html: string; skip: string[]; exact: string | undefined }): PickResult => {
      type Opt = { value: string; text?: string; disabled?: boolean };
      type Doc = {
        createElement(tag: string): { innerHTML: string; querySelector(s: string): unknown };
      };
      const doc = (globalThis as { document?: Doc }).document;
      if (!doc) return null;
      const wrapper = doc.createElement('div');
      wrapper.innerHTML = `<select>${args.html}</select>`;
      const select = wrapper.querySelector('select') as
        | { options: ArrayLike<Opt> }
        | null;
      if (!select) return null;
      const placeholderValues = new Set(['', '0', '-1', 'null', 'undefined']);
      for (let i = 0; i < select.options.length; i++) {
        const o = select.options[i];
        if (!o || !o.value) continue;
        if (o.disabled) continue;
        if (placeholderValues.has(o.value)) continue;
        const text = (o.text ?? '').trim();
        if (args.exact !== undefined) {
          if (o.value === args.exact) return { value: o.value, text };
          continue;
        }
        if (args.skip.indexOf(o.value) !== -1) continue;
        return { value: o.value, text };
      }
      return null;
    },
    { html: fetched.html, skip: skipSellers, exact: exactSellerPin },
  )) as PickResult;
  if (!picked) {
    logger.warn(
      { region, skipSellers, exactSellerPin, htmlLength: fetched.html.length },
      'maxi-carrefour: no eligible seller in fetched list',
    );
    return undefined;
  }

  // 3. Inject the freshly-fetched options into #seller and commit our pick.
  //    Setting innerHTML mirrors what the site's getSellerList() would have
  //    done. Then we set the value + fire change, which runs the site's
  //    onchangeSelect handler (updates step3 button state) for parity with a
  //    manual selection.
  await page.evaluate(
    (args: { html: string; sellerValue: string }) => {
      type Sel = { innerHTML: string; value: string; dispatchEvent(e: Event): boolean };
      const sel = (globalThis as { document?: { getElementById(id: string): unknown } })
        .document?.getElementById('seller') as Sel | null;
      if (!sel) return;
      sel.innerHTML = args.html;
      sel.value = args.sellerValue;
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    },
    { html: fetched.html, sellerValue: picked.value },
  );
  logger.debug(
    { region, seller: picked.value, sellerText: picked.text },
    'maxi-carrefour: seller injected + selected',
  );
  return picked.value;
}

// =============================================================================
// Persistence — write fresh cookie back to supermarkets.config in Postgres
// =============================================================================

export interface PersistOptions {
  /**
   * When true, also write `maxiCarrefourLogin.pick = { region, seller }` so
   * future refreshes start with the same sucursal (which we just confirmed
   * carries the operator's products). Set when verification passed.
   */
  autoPin?: boolean;
  /**
   * An EAN confirmed to unlock a real price with this cookie at the pinned
   * sucursal. Stored as `config.canaryEan` and re-probed by the adapter to
   * tell "cookie expired" apart from "product not stocked here". Set this
   * when seeding so the server can detect expiry accurately.
   */
  canaryEan?: string;
}

/**
 * Persist a fresh cookie into `supermarkets.config.phpSessId` so the next
 * scrape (in this process, or any other worker) starts with a valid session.
 *
 * Best-effort: a DB error here is logged but does NOT fail the caller. The
 * caller already has a valid cookie in hand and can finish its current scrape.
 */
export async function persistCookie(
  supermarketId: string,
  result: LoginResult,
  logger: Logger,
  opts: PersistOptions = {},
): Promise<void> {
  // Lazy import: keeps this module importable in environments without DB
  // env vars (e.g. local Playwright debug scripts).
  const { db } = await import('../shared/db.js');

  // Read existing config so we merge instead of clobbering.
  const { data: row, error: readErr } = await db
    .from('supermarkets')
    .select('config')
    .eq('id', supermarketId)
    .single();
  if (readErr) {
    logger.warn({ err: readErr.message }, 'maxi-carrefour: failed to read config — skipping persist');
    return;
  }

  const existing = (row?.config ?? {}) as Record<string, unknown>;
  const now = new Date().toISOString();
  const next: Record<string, unknown> = {
    ...existing,
    phpSessId: result.phpSessId,
    // Always bump on any persist — used as a freshness/forensics signal.
    phpSessIdRefreshedAt: now,
  };
  // Only bump the *validated* timestamp when this cookie has been confirmed
  // to unlock a real price (autoPin === true means probeEanHasRealPrice
  // returned true for verifyEan). The adapter's "recently-validated"
  // shortcut keys off this timestamp to know when a `data-price="private"`
  // means "product not stocked here" vs "cookie is bad". Persisting an
  // *unverified* fallback cookie must NOT update this — otherwise every
  // subsequent product is treated as not-stocked without ever testing the
  // cookie.
  if (opts.autoPin) {
    next['phpSessIdValidatedAt'] = now;
  }
  if (result.expiresAt) next['phpSessIdExpiresAt'] = result.expiresAt;
  if (result.region) next['lastLoginRegion'] = result.region;
  if (result.seller) next['lastLoginSeller'] = result.seller;
  // Store the canary EAN so the adapter can later distinguish an expired
  // cookie from a product simply not stocked at the pinned sucursal.
  if (opts.canaryEan) next['canaryEan'] = opts.canaryEan;

  // Auto-pin the verified sucursal: future refreshes start here instead of
  // scanning sellers from scratch. Operator can override by editing the
  // config manually — we never overwrite an explicit pin if one exists.
  if (opts.autoPin && result.region && result.seller) {
    const existingLogin = (existing['maxiCarrefourLogin'] ?? {}) as Record<string, unknown>;
    const existingPick = existingLogin['pick'];
    const operatorPinned =
      existingPick &&
      typeof existingPick === 'object' &&
      !Array.isArray(existingPick) &&
      ('region' in existingPick || 'seller' in existingPick);
    if (!operatorPinned) {
      next['maxiCarrefourLogin'] = {
        ...existingLogin,
        pick: { region: result.region, seller: result.seller },
      };
    }
  }

  const { error: writeErr } = await db
    .from('supermarkets')
    .update({ config: next })
    .eq('id', supermarketId);
  if (writeErr) {
    logger.warn({ err: writeErr.message }, 'maxi-carrefour: failed to persist new cookie');
    return;
  }
  logger.info({ supermarketId }, 'maxi-carrefour: persisted fresh PHPSESSID to DB');
}

// =============================================================================
// Cookie verification probe (Node fetch, mirrors what the adapter does)
// =============================================================================

/**
 * Probe an EAN with a freshly-harvested cookie and return whether the FIRST
 * `cart_button` in the response shows a real (non-"private") price.
 *
 * This mirrors `readCartButtonAttr` in the adapter so a "true" here
 * guarantees the next `scrape()` call will succeed with the same cookie.
 */
async function probeEanHasRealPrice(
  cookie: string,
  ean: string,
  signal?: AbortSignal,
): Promise<boolean> {
  // No leading slash on `currentUrl` — with one the server ignores the
  // param and returns generic recommendations (see maxi-carrefour.ts header).
  const url =
    `https://${HOST}/products?currentUrl=p/${encodeURIComponent(ean)}` +
    `&method=getProductBasicData`;
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,*/*',
      'Accept-Language': 'es-AR,es;q=0.9',
      Referer: HOMEPAGE,
      'X-Requested-With': 'XMLHttpRequest',
      Cookie: `PHPSESSID=${cookie}`,
    },
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) return false;
  const html = await res.text();
  // Same regex as the adapter's readCartButtonAttr: grab the first cart_button
  // tag (which is always the requested product, with cross-sells after it).
  const blockMatch = html.match(
    /<(?:div|button)\b[^>]*class=["'][^"']*\bcart_button\b[^"']*["'][^>]*>/i,
  );
  if (!blockMatch) return false;
  const priceMatch = blockMatch[0].match(/data-price=["']([^"']+)["']/i);
  if (!priceMatch?.[1]) return false;
  return priceMatch[1] !== 'private' && priceMatch[1] !== '';
}

// =============================================================================
// Public helper — process-level singleton, used by the adapter
// =============================================================================

export interface RefreshOptions {
  /**
   * EAN to verify the harvested cookie against. When set, the helper loops
   * through sellers until it finds one that returns a real price for this
   * EAN (then auto-pins it). Without this, we accept whatever cookie the
   * first login gives us.
   */
  verifyEan?: string;
  /**
   * Max sellers to try before giving up. Each attempt is a full Playwright
   * login (~15-20s + reCAPTCHA roundtrip). The loop will rotate across
   * regions when a region's sellers are exhausted, so this caps the TOTAL
   * attempts across all regions (not per-region).
   */
  maxAttempts?: number;
  /**
   * After this many consecutive misses in the SAME region, the loop will
   * skip that region entirely and try the next one. Defaults to 3 — most
   * BS AS regions have 3-5 sellers, so this gives every region a fair
   * shot before moving on.
   */
  maxSellersPerRegion?: number;
  /** Override Playwright launch options. */
  launchOpts?: LaunchOptions;
}

/**
 * Process-singleton: while one login is in flight, every other concurrent
 * call awaits the same Promise. This prevents N parallel scraping jobs from
 * spawning N Playwright instances when the cookie expires.
 *
 * Keyed by EAN so two scrapes for different products can each find their
 * own working sucursal in parallel (still de-duped per-EAN).
 */
const loginInFlight = new Map<string, Promise<LoginResult>>();

/**
 * Cooldown gate. After a refreshCookie call THROWS, we record the timestamp
 * here; subsequent calls within REFRESH_COOLDOWN_MS short-circuit with the
 * same error instead of spinning up another Playwright login.
 *
 * Why: reCAPTCHA Enterprise scores drop progressively when N back-to-back
 * logins come from the same IP. Once the score crosses Google's reject
 * threshold, every subsequent login *also* fails — and we'd just burn more
 * minutes of CPU and tank the score further. Backing off lets the score
 * recover on its own.
 */
let lastRefreshFailureAt: number | undefined;
let lastRefreshFailureErr: ScrapeError | undefined;
const REFRESH_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * Reset the cooldown — useful in tests, or if the operator manually resolves
 * the underlying issue and wants the next scrape to retry immediately.
 */
export function clearRefreshCooldown(): void {
  lastRefreshFailureAt = undefined;
  lastRefreshFailureErr = undefined;
}

/**
 * Force a fresh PHPSESSID via Playwright login, persist it to DB, and return
 * it. Concurrent calls (with the same `verifyEan`) share a single login.
 *
 * Strategy:
 *   1. Use whatever sucursal is pinned in `supermarkets.config.maxiCarrefour
 *      Login.pick` (or "first available" if nothing pinned).
 *   2. After each login, probe `verifyEan` with the new cookie. If it shows
 *      a real price → done, persist the cookie + auto-pin the seller for
 *      future refreshes.
 *   3. If "private", the picked sucursal doesn't carry this product. Add
 *      its seller id to skipSellers and try again. After `maxSellersPer
 *      Region` consecutive misses in the same region, also add the region
 *      to skipRegions so the next attempt picks a different province.
 *   4. Out of attempts (across all regions) → throw `auth_required` with
 *      a clear message.
 *
 * No cron, no manual intervention: when the cookie expires the next scrape
 * triggers refresh, the working sucursal gets re-pinned (or auto-found),
 * and the operator never has to touch anything.
 */
export async function refreshCookie(
  config: SupermarketConfig,
  logger: Logger,
  opts: RefreshOptions = {},
): Promise<LoginResult> {
  // Honor the process-level cooldown set after a previous refresh failure —
  // see lastRefreshFailureAt comment for rationale. The first failure pays
  // the full Playwright cost; everything within the cooldown window after
  // that fails fast with the cached error.
  if (lastRefreshFailureAt && lastRefreshFailureErr) {
    const ageMs = Date.now() - lastRefreshFailureAt;
    if (ageMs < REFRESH_COOLDOWN_MS) {
      const remainingMin = Math.ceil((REFRESH_COOLDOWN_MS - ageMs) / 60000);
      logger.warn(
        { ageMs, remainingMin, cause: lastRefreshFailureErr.message },
        'maxi-carrefour: skipping refresh, cooldown active',
      );
      throw new ScrapeError(
        'auth_required',
        `Maxi Carrefour: refresh in cooldown (${Math.round(ageMs / 60000)}m ago, ${remainingMin}m left). ` +
          `Last error: ${lastRefreshFailureErr.message}`,
      );
    }
  }

  const verifyEan = opts.verifyEan;
  const dedupeKey = verifyEan ?? '__novalidation__';
  const existing = loginInFlight.get(dedupeKey);
  if (existing) {
    logger.debug({ verifyEan }, 'maxi-carrefour: awaiting in-flight login');
    return existing;
  }

  const promise = (async () => {
    const baseLoginCfg = loadLoginDefaults(config.config);
    const cfgOverrides =
      (config.config?.['maxiCarrefourLogin'] as LaunchOptions | undefined) ?? {};
    const finalLaunch: LaunchOptions = { ...cfgOverrides, ...(opts.launchOpts ?? {}) };
    // Try enough sucursales to find product coverage, but keep a hard cap so
    // one genuinely unavailable EAN can't consume the whole run. With the
    // region priority above this means roughly:
    //   CABA x3 → BS AS (OESTE) x3 → BS AS (NORTE) x3 → BS AS (SUR) x3.
    const maxAttempts = opts.maxAttempts ?? 12;
    const maxSellersPerRegion = opts.maxSellersPerRegion ?? 3;

    // Track per-region misses so we know when to abandon a region.
    const skipSellers: string[] = [];
    const skipRegions: string[] = [];
    const missesByRegion = new Map<string, number>();
    // Per-attempt budget so a single hung attempt can't blow the whole window.
    const perAttemptBudgetMs = LOGIN_TIMEOUT_MS;
    // Sleep between attempts to let reCAPTCHA Enterprise's bot-score recover
    // (back-to-back Playwright runs from the same IP get scored progressively
    // lower; a few seconds of idling clears that signal). Skip when we're
    // succeeding — only sleep before a RETRY.
    const interAttemptCooldownMs = 8_000;

    let lastResult: LoginResult | undefined;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // First attempt honors the operator's pinned sucursal (if any).
      // Subsequent attempts force "first" + skipSellers/Regions to find a NEW one.
      const pick = attempt === 1 ? baseLoginCfg.pick : 'first';
      const attemptCfg: LoginDefaults = {
        ...baseLoginCfg,
        pick,
        skipSellers: [...skipSellers],
        skipRegions: [...skipRegions],
      };
      logger.info(
        { attempt, maxAttempts, pick, skipSellers, skipRegions, verifyEan },
        'maxi-carrefour: login attempt',
      );

      let result: LoginResult;
      try {
        result = await Promise.race([
          loginAndGetCookie(attemptCfg, logger, finalLaunch),
          new Promise<LoginResult>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new ScrapeError(
                    'auth_required',
                    `Maxi Carrefour login attempt ${attempt} exceeded ${perAttemptBudgetMs}ms`,
                  ),
                ),
              perAttemptBudgetMs,
            ),
          ),
        ]);
      } catch (err) {
        // Transient reCAPTCHA rejections / DOM timing flakes manifest as
        // "/login POST never fired" or selector timeouts. Retry — different
        // attempt, different reCAPTCHA token, hopefully different outcome.
        // Real bugs (DOM truly changed) keep failing and exhaust attempts.
        lastErr = err;
        logger.warn(
          { attempt, err: (err as Error).message },
          'maxi-carrefour: login attempt threw, will retry',
        );
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, interAttemptCooldownMs));
        }
        continue;
      }
      lastResult = result;

      // No EAN to verify against → first cookie wins (used by the manual
      // login script and the rare scrape-without-context callers).
      if (!verifyEan) {
        await persistCookie(config.id, result, logger, { autoPin: false });
        return result;
      }

      const ok = await probeEanHasRealPrice(result.phpSessId, verifyEan);
      if (ok) {
        logger.info(
          { attempt, region: result.region, seller: result.seller, verifyEan },
          'maxi-carrefour: cookie unlocks prices for verifyEan — pinning sucursal',
        );
        // Persist + auto-pin so the NEXT refresh skips the sucursal search.
        // verifyEan unlocked a real price here, so it's a valid canary.
        await persistCookie(config.id, result, logger, {
          autoPin: true,
          canaryEan: verifyEan,
        });
        return result;
      }

      logger.warn(
        { attempt, seller: result.seller, region: result.region, verifyEan },
        'maxi-carrefour: cookie returned data-price="private" — trying next seller',
      );
      if (result.seller) skipSellers.push(result.seller);
      // Track region miss; once we've burnt through `maxSellersPerRegion`
      // sellers there, abandon the region entirely so the next attempt
      // jumps to a different province.
      if (result.region) {
        const misses = (missesByRegion.get(result.region) ?? 0) + 1;
        missesByRegion.set(result.region, misses);
        if (misses >= maxSellersPerRegion && !skipRegions.includes(result.region)) {
          skipRegions.push(result.region);
          logger.info(
            { region: result.region, misses, verifyEan },
            'maxi-carrefour: exhausted sellers in region — switching region',
          );
        }
      }
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, interAttemptCooldownMs));
      }
    }

    // Exhausted all attempts. Two distinct failure modes from here:
    //
    //   A. We never harvested a cookie (every attempt threw at the Playwright
    //      stage). That's a genuine auth failure — reCAPTCHA blocked us, the
    //      DOM changed, etc. Re-raise as `auth_required` and arm the cooldown
    //      (handled by the outer try/catch).
    //
    //   B. We harvested N cookies, but verifyEan came back "private" at every
    //      sucursal. The cookies themselves are fine — they may unlock prices
    //      for OTHER products. The picked sucursales just don't carry THIS
    //      specific EAN. Persisting the cookie lets every other product in
    //      this scrape batch use it (saving N-1 logins). Throw
    //      `region_unavailable` so this one product fails cleanly without
    //      dragging the rest of the batch into the auth_required cooldown —
    //      and so it's distinguishable from a genuinely deleted product.
    if (lastErr && !lastResult) {
      // Mode A — bubble up so the outer catch arms the cooldown.
      throw lastErr instanceof Error
        ? lastErr
        : new ScrapeError('auth_required', String(lastErr));
    }
    if (lastResult) {
      // Mode B — best-effort persist (no auto-pin since this sucursal didn't
      // verify), then throw product_not_found.
      logger.info(
        {
          region: lastResult.region,
          seller: lastResult.seller,
          verifyEan,
          triedSellers: skipSellers,
        },
        'maxi-carrefour: harvested cookie but verifyEan unstocked at all tried sucursales — ' +
          'persisting cookie for other products to reuse',
      );
      await persistCookie(config.id, lastResult, logger, { autoPin: false });
      throw new ScrapeError(
        'region_unavailable',
        `Maxi Carrefour: EAN ${verifyEan} is not stocked at any of the ` +
          `${maxAttempts} tried sucursales (sellers=${skipSellers.join(',')}, ` +
          `regions=${skipRegions.join(',')}). The harvested cookie has been ` +
          `persisted for other products to reuse — only this EAN failed. ` +
          `If this product really should be available, pin a sucursal that ` +
          `carries it via supermarkets.config.maxiCarrefourLogin.pick.`,
      );
    }
    // Should be unreachable (lastErr or lastResult must be set after the
    // loop), but throw a coherent error just in case.
    throw new ScrapeError('auth_required', 'Maxi Carrefour: refresh produced no result');
  })();

  loginInFlight.set(dedupeKey, promise);
  try {
    const result = await promise;
    // Refresh succeeded — clear any lingering cooldown so other in-flight
    // products don't get spuriously short-circuited.
    clearRefreshCooldown();
    return result;
  } catch (err) {
    // Only arm the cooldown for genuine auth failures (Playwright/reCAPTCHA
    // problems, no cookie ever harvested). `product_not_found` means we have
    // a working cookie persisted, so the next product's scrape can reuse it
    // — arming the cooldown would block it spuriously.
    const isAuthFailure =
      err instanceof ScrapeError ? err.type === 'auth_required' : true;
    if (isAuthFailure) {
      lastRefreshFailureAt = Date.now();
      lastRefreshFailureErr =
        err instanceof ScrapeError
          ? err
          : new ScrapeError('auth_required', (err as Error).message);
    }
    throw err;
  } finally {
    loginInFlight.delete(dedupeKey);
  }
}
