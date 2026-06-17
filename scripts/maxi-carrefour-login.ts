/**
 * Manual Maxi Carrefour login — drives Playwright to harvest a fresh
 * PHPSESSID and either prints it (dry-run) or writes it to the database.
 *
 * The adapter does this automatically when it sees `data-price="private"`,
 * so you usually don't need this script. Reach for it when:
 *   - First-time DB seeding (so the very first scrape doesn't pay the
 *     login cost).
 *   - Debugging a failing login flow with `--headed` to watch what's
 *     happening on the page.
 *   - Forcing a refresh on demand after manual config changes.
 *   - Finding a sucursal (seller) that carries your specific products.
 *
 * Usage:
 *   npm run maxi-carrefour:login                # headless, persist to DB
 *   npm run maxi-carrefour:login -- --dry-run   # login, print cookie, no DB
 *   npm run maxi-carrefour:login -- --headed    # show the browser window
 *   npm run maxi-carrefour:login -- --no-chrome # use bundled chromium
 *   npm run maxi-carrefour:login -- --edge      # use installed Microsoft Edge
 *   npm run maxi-carrefour:login -- --region=BS_AS_NORTE --seller=219
 *                                               # pin a specific sucursal
 *   npm run maxi-carrefour:login -- --dry-run --probe=7791130002240,7793253004361
 *                                               # after harvesting cookie,
 *                                               #   probe each EAN and report
 *                                               #   data-price (real | private |
 *                                               #   missing). Use this to
 *                                               #   validate that the login
 *                                               #   actually binds a seller
 *                                               #   before deploying.
 */

import { logger } from '../src/shared/logger.js';
import {
  loginAndGetCookie,
  persistCookie,
  type LoginResult,
} from '../src/adapters/maxi-carrefour-auth.js';

interface Flags {
  dryRun: boolean;
  headless: boolean;
  useSystemChrome: boolean;
  browserChannel?: 'chrome' | 'msedge';
  region?: string;
  seller?: string;
  probeEans?: string[];
}

function parseFlags(argv: readonly string[]): Flags {
  const flags: Flags = {
    dryRun: argv.includes('--dry-run'),
    headless: !argv.includes('--headed') && !argv.includes('--no-headless'),
    useSystemChrome: !argv.includes('--no-chrome'),
  };
  for (const arg of argv) {
    if (arg === '--edge') flags.browserChannel = 'msedge';
    if (arg === '--chrome') flags.browserChannel = 'chrome';
    if (arg.startsWith('--channel=')) {
      const channel = arg.slice('--channel='.length);
      if (channel === 'chrome' || channel === 'msedge') flags.browserChannel = channel;
    }
    if (arg.startsWith('--region=')) flags.region = arg.slice('--region='.length);
    if (arg.startsWith('--seller=')) flags.seller = arg.slice('--seller='.length);
    if (arg.startsWith('--probe=')) {
      // Split on commas OR whitespace: some shells (notably PowerShell)
      // rewrite `--probe=a,b,c` into `--probe=a b c`, so accept both.
      flags.probeEans = arg
        .slice('--probe='.length)
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return flags;
}

/**
 * Hit `getProductBasicData` for a single EAN with the harvested cookie and
 * extract the cart_button's `data-price`. Mirrors what the adapter does so
 * the result here predicts what the adapter will see.
 */
async function probeEan(
  cookie: string,
  ean: string,
): Promise<{ status: number; dataPrice: string | undefined; description: string | undefined }> {
  const url =
    `https://comerciante.carrefour.com.ar/products?currentUrl=p/${encodeURIComponent(ean)}` +
    `&method=getProductBasicData`;
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,*/*',
      'Accept-Language': 'es-AR,es;q=0.9',
      Referer: 'https://comerciante.carrefour.com.ar/',
      'X-Requested-With': 'XMLHttpRequest',
      Cookie: `PHPSESSID=${cookie}`,
    },
  });
  if (!res.ok) return { status: res.status, dataPrice: undefined, description: undefined };
  const html = await res.text();
  const tagMatch = html.match(
    /<(?:div|button)\b[^>]*class=["'][^"']*\bcart_button\b[^"']*["'][^>]*>/i,
  );
  const dataPrice = tagMatch?.[0].match(/data-price=["']([^"']+)["']/i)?.[1];
  const description = tagMatch?.[0].match(/data-description=["']([^"']+)["']/i)?.[1];
  return { status: res.status, dataPrice, description };
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  // Build a pick override: when --region or --seller are present, pin them.
  const pick =
    flags.region || flags.seller
      ? {
          ...(flags.region ? { region: flags.region } : {}),
          ...(flags.seller ? { seller: flags.seller } : {}),
        }
      : ('first' as const);

  const loginCfg = {
    name: 'Juan Perez',
    numberId: '30123456',
    phone: '01111111111',
    email: 'price-watch-bot@example.com',
    pick,
  };

  logger.info({ flags, pick }, 'maxi-carrefour: starting manual login');

  let result: LoginResult;
  try {
    result = await loginAndGetCookie(loginCfg, logger, {
      headless: flags.headless,
      useSystemChrome: flags.useSystemChrome,
      browserChannel: flags.browserChannel,
    });
  } catch (err) {
    logger.error({ err }, 'maxi-carrefour: login failed');
    process.exitCode = 1;
    return;
  }

  console.log('\n--- LoginResult ---');
  console.log(JSON.stringify(result, null, 2));
  console.log(`\nPHPSESSID = ${result.phpSessId}`);

  // Optional verification: probe each EAN with the harvested cookie and
  // report data-price. This is the ground-truth test of whether the login
  // actually bound a seller — if data-price is "private" for everything,
  // the cookie isn't usable and there's no point persisting it.
  let probeRealCount: number | undefined;
  // First EAN that unlocked a real price — stored as the cookie's canary so
  // production can later tell "cookie expired" from "product not stocked".
  let canaryEan: string | undefined;
  if (flags.probeEans?.length) {
    console.log('\n--- Cookie verification probes ---');
    let realCount = 0;
    for (const ean of flags.probeEans) {
      try {
        const { status, dataPrice, description } = await probeEan(result.phpSessId, ean);
        const verdict =
          dataPrice === undefined
            ? `MISSING cart_button (status=${status})`
            : dataPrice === 'private' || dataPrice === ''
            ? 'PRIVATE — cookie does NOT unlock prices for this EAN'
            : `REAL price = ${dataPrice}`;
        if (dataPrice && dataPrice !== 'private' && dataPrice !== '') {
          realCount++;
          if (!canaryEan) canaryEan = ean;
        }
        console.log(`  ${ean}  →  ${verdict}${description ? ` [${description.slice(0, 60)}]` : ''}`);
      } catch (err) {
        console.log(`  ${ean}  →  ERROR: ${(err as Error).message}`);
      }
    }
    probeRealCount = realCount;
    console.log(
      `\nVerdict: ${realCount}/${flags.probeEans.length} EANs unlocked. ` +
        (realCount === 0
          ? 'Login flow is broken — cookie does not bind a seller. Investigate before deploying.'
          : realCount < flags.probeEans.length
          ? 'Cookie works but some EANs are not stocked at the picked sucursal. Try a different region/seller.'
          : 'All EANs unlocked — login flow is healthy.'),
    );
  }

  if (flags.dryRun) {
    console.log('\n(dry-run: not persisting to DB)');
    return;
  }

  // Safety: never persist a cookie that we KNOW is broken. If probes were
  // requested and NONE unlocked a price, the cookie doesn't bind a seller —
  // writing it to the DB would just poison production with a dead session.
  // (When no probes are requested we can't tell, so we persist as before.)
  if (probeRealCount === 0) {
    console.log(
      '\nNOT persisting: 0 EANs unlocked — this cookie is broken. ' +
        'Re-run (with --edge --headed) until the verdict shows at least 1 unlocked.',
    );
    process.exitCode = 1;
    return;
  }

  try {
    await persistCookie(
      'maxi-carrefour',
      result,
      logger,
      canaryEan ? { canaryEan } : {},
    );
    console.log(
      `\nPersisted to supermarkets.config.phpSessId` +
        (canaryEan ? ` (canary EAN: ${canaryEan})` : ''),
    );
  } catch (err) {
    logger.error({ err }, 'maxi-carrefour: failed to persist cookie to DB');
    process.exitCode = 1;
  }
}

void main();
