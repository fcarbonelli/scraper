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
 *   npm run maxi-carrefour:login -- --append --region="BS AS (NORTE)" --seller=72 --probe=<ean>
 *                                               # seed an EXTRA sucursal as a
 *                                               #   fallback (config.maxiSessions)
 *                                               #   without touching the primary
 *                                               #   cookie. Run once per extra
 *                                               #   sucursal you want covered.
 *   npx tsx --env-file=.env scripts/maxi-carrefour-login.ts --edge \
 *     --seed-region="CABA" "--probe=<staple_ean>,<target_ean>"
 *                                               # BULK-seed every sucursal in a
 *                                               #   region as fallbacks: logs in
 *                                               #   to each, validates with the
 *                                               #   probe EANs, appends the ones
 *                                               #   that work. Put a broadly-
 *                                               #   stocked EAN first. Cap with
 *                                               #   --max-sellers=N (default 8).
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
  appendSession,
  removeSession,
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
  /**
   * Store this login as an extra *fallback* sucursal in config.maxiSessions
   * instead of overwriting the primary phpSessId. Lets the adapter retry
   * products missing at the primary sucursal against additional ones.
   */
  append: boolean;
  /**
   * Bulk-seed EVERY sucursal in this region as a fallback session. Logs in
   * once per sucursal, validates with --probe, and appends the working ones.
   * Implies --append. Requires --probe=<known_stocked_ean[,...]>.
   */
  seedRegion?: string;
  /** Cap how many sucursales --seed-region attempts (default 8). */
  maxSellers?: number;
  /** Remove a fallback session (by seller id) from config.maxiSessions. */
  removeSeller?: string;
}

const PROBE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const PROBE_HOST = 'comerciante.carrefour.com.ar';

function parseFlags(argv: readonly string[]): Flags {
  const flags: Flags = {
    dryRun: argv.includes('--dry-run'),
    headless: !argv.includes('--headed') && !argv.includes('--no-headless'),
    useSystemChrome: !argv.includes('--no-chrome'),
    append: argv.includes('--append'),
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
    if (arg.startsWith('--seed-region=')) flags.seedRegion = arg.slice('--seed-region='.length);
    if (arg.startsWith('--max-sellers=')) {
      const n = Number.parseInt(arg.slice('--max-sellers='.length), 10);
      if (Number.isFinite(n) && n > 0) flags.maxSellers = n;
    }
    if (arg.startsWith('--remove-seller=')) flags.removeSeller = arg.slice('--remove-seller='.length);
    if (arg.startsWith('--probe=')) {
      // Split on commas OR whitespace: some shells (notably PowerShell)
      // rewrite `--probe=a,b,c` into `--probe=a b c`, so accept both.
      const tokens = arg
        .slice('--probe='.length)
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      // Keep only things that look like EANs (8–14 digits). This guards
      // against mangled pastes / shell quoting accidents where flags or whole
      // command fragments leak into the probe list — a non-EAN token like
      // "--edge" can otherwise return a recommendation price and be wrongly
      // stored as a canary, silently poisoning the session's health check.
      const valid = tokens.filter((t) => /^\d{8,14}$/.test(t));
      const dropped = tokens.filter((t) => !/^\d{8,14}$/.test(t));
      if (dropped.length) {
        console.warn(
          `WARNING: ignoring ${dropped.length} non-EAN --probe token(s): ` +
            dropped.map((d) => JSON.stringify(d)).join(', '),
        );
      }
      flags.probeEans = valid;
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

/**
 * List every sucursal (seller) for a region via the same unauthenticated XHR
 * the login wizard uses. deliveryType=0 ("retiro"/pickup) returns the widest
 * set of stores. Returns [{id, name}], skipping placeholder/disabled options.
 */
async function fetchSellerList(region: string): Promise<Array<{ id: string; name: string }>> {
  const res = await fetch(`https://${PROBE_HOST}/seller?method=sellersLists`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': PROBE_UA,
      Referer: `https://${PROBE_HOST}/`,
    },
    body: `zoneId=${encodeURIComponent(region)}&deliveryType=0`,
  });
  if (!res.ok) throw new Error(`sellersLists HTTP ${res.status}`);
  const html = await res.text();
  const placeholders = new Set(['', '0', '-1', 'null', 'undefined']);
  const sellers: Array<{ id: string; name: string }> = [];
  const re = /<option\b([^>]*)>([^<]*)<\/option>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] ?? '';
    if (/\bdisabled\b/i.test(attrs)) continue;
    const id = attrs.match(/value=["']([^"']*)["']/i)?.[1]?.trim() ?? '';
    if (placeholders.has(id)) continue;
    sellers.push({ id, name: (m[2] ?? '').trim() });
  }
  return sellers;
}

/**
 * Bulk-seed every sucursal in a region: log in to each, validate the cookie by
 * probing known-stocked EANs, and append the working ones to
 * config.maxiSessions. This gives the adapter a pool of same-region cookies to
 * retry products that aren't carried at the primary sucursal.
 */
async function seedRegion(flags: Flags): Promise<void> {
  const region = flags.seedRegion!;
  if (!flags.probeEans?.length) {
    console.log(
      '\n--seed-region requires --probe=<known_stocked_ean[,...]> so each ' +
        "sucursal's cookie can be validated. Put a broadly-stocked staple first.",
    );
    process.exitCode = 1;
    return;
  }

  const loginCfgBase = {
    name: 'Juan Perez',
    numberId: '30123456',
    phone: '01111111111',
    email: 'price-watch-bot@example.com',
  };

  console.log(`\nEnumerating sucursales for region "${region}"...`);
  let sellers: Array<{ id: string; name: string }>;
  try {
    sellers = await fetchSellerList(region);
  } catch (err) {
    console.log(`Failed to list sucursales: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }
  const cap = flags.maxSellers ?? 8;
  if (sellers.length > cap) sellers = sellers.slice(0, cap);
  if (sellers.length === 0) {
    console.log(`No sucursales returned for "${region}" — check the region name.`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `Found ${sellers.length} sucursal(es): ` +
      sellers.map((s) => `${s.id} (${s.name})`).join(', '),
  );

  let seeded = 0;
  for (const s of sellers) {
    console.log(`\n--- Sucursal ${s.id} — ${s.name} ---`);
    let result: LoginResult;
    try {
      result = await loginAndGetCookie(
        { ...loginCfgBase, pick: { region, seller: s.id } },
        logger,
        {
          headless: flags.headless,
          useSystemChrome: flags.useSystemChrome,
          browserChannel: flags.browserChannel,
        },
      );
    } catch (err) {
      console.log(`  login failed: ${(err as Error).message} — skipping`);
      continue;
    }

    // Validate: find the first probe EAN that unlocks here → that's the
    // sucursal's canary. If none unlock, the cookie is unverified — skip it
    // rather than poison the pool with a possibly-dead session.
    let canaryEan: string | undefined;
    for (const ean of flags.probeEans) {
      try {
        const { dataPrice } = await probeEan(result.phpSessId, ean);
        if (dataPrice && dataPrice !== 'private' && dataPrice !== '') {
          canaryEan = ean;
          break;
        }
      } catch {
        /* try next EAN */
      }
    }
    if (!canaryEan) {
      console.log('  no probe EAN unlocked here — skipping (cookie unverified)');
      continue;
    }

    if (flags.dryRun) {
      console.log(`  OK (canary ${canaryEan}) — dry-run, not persisting`);
      seeded++;
      continue;
    }
    try {
      await appendSession('maxi-carrefour', result, logger, { canaryEan });
      console.log(`  appended (seller=${s.id}, canary=${canaryEan})`);
      seeded++;
    } catch (err) {
      console.log(`  failed to persist: ${(err as Error).message}`);
    }
  }
  console.log(`\nDone: seeded ${seeded}/${sellers.length} sucursal(es) for "${region}".`);
  if (seeded === 0) process.exitCode = 1;
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));

  // Pool maintenance: drop a fallback sucursal by seller id (no login needed).
  if (flags.removeSeller) {
    const removed = await removeSession('maxi-carrefour', flags.removeSeller, logger);
    console.log(
      removed > 0
        ? `Removed ${removed} fallback session(s) for seller ${flags.removeSeller}.`
        : `No fallback session for seller ${flags.removeSeller} (nothing to remove).`,
    );
    return;
  }

  // Bulk multi-sucursal seeding takes a different path (many logins).
  if (flags.seedRegion) {
    await seedRegion(flags);
    return;
  }
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
    let privateCount = 0; // cookie didn't unlock price (likely bad/unbound cookie)
    let missingCount = 0; // no cart_button (product not carried at this sucursal)
    for (const ean of flags.probeEans) {
      try {
        const { status, dataPrice, description } = await probeEan(result.phpSessId, ean);
        const verdict =
          dataPrice === undefined
            ? `MISSING cart_button (status=${status}) — not carried at this sucursal`
            : dataPrice === 'private' || dataPrice === ''
            ? 'PRIVATE — cookie does NOT unlock prices for this EAN'
            : `REAL price = ${dataPrice}`;
        if (dataPrice === undefined) {
          missingCount++;
        } else if (dataPrice === 'private' || dataPrice === '') {
          privateCount++;
        } else {
          realCount++;
          if (!canaryEan) canaryEan = ean;
        }
        console.log(`  ${ean}  →  ${verdict}${description ? ` [${description.slice(0, 60)}]` : ''}`);
      } catch (err) {
        console.log(`  ${ean}  →  ERROR: ${(err as Error).message}`);
      }
    }
    probeRealCount = realCount;
    // Diagnose 0-unlocked: PRIVATE means the cookie didn't bind a seller (real
    // login problem); MISSING means the cookie is fine but those products just
    // aren't stocked at this sucursal — you simply probed the wrong EANs here.
    const zeroDiagnosis =
      privateCount > 0
        ? 'Cookie did NOT bind a seller (got PRIVATE). Login flow is broken — investigate before deploying.'
        : 'Cookie likely bound, but NONE of the probed EANs are stocked at this ' +
          'sucursal (all MISSING). Add a known-stocked EAN to --probe to confirm ' +
          'the cookie, or pick a sucursal that carries your target EAN.';
    console.log(
      `\nVerdict: ${realCount}/${flags.probeEans.length} EANs unlocked ` +
        `(${realCount} real, ${privateCount} private, ${missingCount} missing). ` +
        (realCount === 0
          ? zeroDiagnosis
          : realCount < flags.probeEans.length
          ? 'Cookie works but some EANs are not stocked at the picked sucursal. Try a different region/seller for those.'
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
      '\nNOT persisting: 0 EANs unlocked, so we cannot confirm this cookie works. ' +
        'If the probes were all MISSING (not PRIVATE), the cookie is probably fine — ' +
        'you just probed EANs not stocked at this sucursal. Re-run with a ' +
        'known-stocked EAN in --probe (e.g. "--probe=<known_good>,7793253003524") ' +
        'so the script can verify the cookie before persisting.',
    );
    process.exitCode = 1;
    return;
  }

  try {
    if (flags.append) {
      // Multi-sucursal seeding: add this session as a fallback (keyed by
      // seller) without disturbing the primary cookie or canary.
      await appendSession('maxi-carrefour', result, logger, canaryEan ? { canaryEan } : {});
      console.log(
        `\nAppended to supermarkets.config.maxiSessions` +
          ` (seller=${result.seller ?? '?'}, region=${result.region ?? '?'}` +
          (canaryEan ? `, canary EAN: ${canaryEan}` : '') +
          `). The adapter will retry products here when they're missing at ` +
          `other sucursales.`,
      );
    } else {
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
    }
  } catch (err) {
    logger.error({ err }, 'maxi-carrefour: failed to persist cookie to DB');
    process.exitCode = 1;
  }
}

void main();
