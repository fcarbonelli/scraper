/**
 * Maxi Carrefour session keepalive.
 *
 * Why this exists:
 *   The PHPSESSID that unlocks prices is created by a reCAPTCHA-protected
 *   login that ONLY scores high enough from a residential IP — it can't be
 *   generated on the EC2 (AWS datacenter) box. However, a cookie seeded from
 *   a residential IP DOES work for price fetches from EC2 (the price endpoint
 *   doesn't re-check IP). The catch: PHP expires the session after a short
 *   period of inactivity (default gc_maxlifetime ≈ 24 min). Since the real
 *   scrape only runs once a day, the session is long dead by the next run.
 *
 *   This script "touches" the session on a schedule (cron, every ~10 min) by
 *   making one authenticated request with the stored cookie. That keeps the
 *   session's last-access fresh so PHP's GC doesn't reap it — letting a single
 *   residential seed survive indefinitely (or at least until any hard cap).
 *
 * What it does:
 *   1. Read `supermarkets.config.phpSessId` + `canaryEan` from the DB.
 *   2. Fetch the canary product with that cookie.
 *   3. Log whether the cookie still unlocks a real price.
 *      - alive  → session kept warm; nothing else to do.
 *      - dead   → log a warning (re-seed needed from a residential IP). We
 *                 deliberately DON'T try to re-login here: headless login from
 *                 EC2 can't pass reCAPTCHA and would clobber a good cookie.
 *
 * Usage (cron on EC2, e.g. every 10 minutes):
 *   *\/10 * * * * cd /home/ubuntu/scraper && \
 *     /usr/bin/npx tsx --env-file=.env scripts/maxi-carrefour-keepalive.ts >> \
 *     /home/ubuntu/scraper/logs/maxi-keepalive.log 2>&1
 */

import { db } from '../src/shared/db.js';
import { logger } from '../src/shared/logger.js';

const HOST = 'comerciante.carrefour.com.ar';

interface MaxiConfig {
  phpSessId?: string;
  canaryEan?: string;
}

/** Fetch the canary product with the cookie; return its data-price (or null). */
async function probePrice(cookie: string, ean: string): Promise<string | null> {
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
      Referer: `https://${HOST}/`,
      'X-Requested-With': 'XMLHttpRequest',
      Cookie: `PHPSESSID=${cookie}`,
    },
  });
  if (!res.ok) return null;
  const html = await res.text();
  const tag = html.match(
    /<(?:div|button)\b[^>]*class=["'][^"']*\bcart_button\b[^"']*["'][^>]*>/i,
  );
  return tag?.[0].match(/data-price=["']([^"']+)["']/i)?.[1] ?? null;
}

async function main(): Promise<void> {
  const { data: row, error } = await db
    .from('supermarkets')
    .select('config')
    .eq('id', 'maxi-carrefour')
    .single();
  if (error) {
    logger.error({ err: error.message }, 'maxi-keepalive: failed to read config');
    process.exitCode = 1;
    return;
  }

  const config = (row?.config ?? {}) as MaxiConfig;
  const cookie = config.phpSessId;
  const canaryEan = config.canaryEan;

  if (!cookie) {
    logger.warn({}, 'maxi-keepalive: no PHPSESSID configured — nothing to keep warm');
    return;
  }
  if (!canaryEan) {
    logger.warn(
      {},
      'maxi-keepalive: no canaryEan configured — re-seed locally to enable keepalive checks',
    );
    return;
  }

  // Touch the homepage first with the cookie. The product endpoint is a
  // read; the homepage does a full session_start and is more likely to
  // re-write the session (CSRF/flash state), refreshing its last-write time
  // so PHP's GC (mtime-based) doesn't reap it. Best-effort — ignore errors.
  await fetch(`https://${HOST}/`, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      'Accept-Language': 'es-AR,es;q=0.9',
      Cookie: `PHPSESSID=${cookie}`,
    },
  }).catch(() => undefined);

  const price = await probePrice(cookie, canaryEan);
  const alive = Boolean(price && price !== 'private' && price !== '');

  if (alive) {
    logger.info({ canaryEan, price }, 'maxi-keepalive: session alive (kept warm)');
  } else {
    logger.warn(
      { canaryEan, price: price ?? 'none' },
      'maxi-keepalive: session DEAD — re-seed from a residential IP ' +
        '(npx tsx --env-file=.env scripts/maxi-carrefour-login.ts --edge --headed "--probe=<eans>")',
    );
    process.exitCode = 1;
  }
}

void main();
