/**
 * Maxi Carrefour session keepalive (reusable core).
 *
 * Why this exists:
 *   The PHPSESSID that unlocks prices is minted by a reCAPTCHA-protected login
 *   that only scores high enough from a residential IP — it CANNOT be generated
 *   on the EC2 (AWS datacenter) box. A cookie seeded from a residential IP does
 *   work for price fetches from EC2 (the price endpoint doesn't re-check IP),
 *   BUT PHP reaps the session after a short idle window (gc_maxlifetime ≈ 24
 *   min). Since the real scrape runs once a day, every seeded session is long
 *   dead by the next run — which is exactly how we lost days of Maxi Carrefour
 *   scraping (seeds expired overnight with nothing touching them).
 *
 *   This module "touches" every seeded session on a schedule so PHP's GC never
 *   reaps them, letting a single residential seed survive indefinitely. It is a
 *   plain `fetch` (no Playwright / no reCAPTCHA), so it runs fine from EC2. It
 *   is invoked both by the standalone CLI (scripts/maxi-carrefour-keepalive.ts)
 *   and, in production, by a cron inside the orchestrator so it runs every ~10
 *   min without any external crontab.
 *
 *   It deliberately NEVER re-logs-in: a headless login from EC2 can't pass
 *   reCAPTCHA and would clobber a good cookie. When a session is found dead it
 *   is only logged (re-seed from a residential IP via maxi-carrefour-login.ts).
 */

import type { Logger } from 'pino';
import { db } from '../shared/db.js';
import { logger as rootLogger } from '../shared/logger.js';

const HOST = 'comerciante.carrefour.com.ar';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

interface MaxiSession {
  phpSessId?: string;
  canaryEan?: string;
  seller?: string;
}

interface MaxiConfig {
  phpSessId?: string;
  canaryEan?: string;
  maxiSessions?: MaxiSession[];
}

export interface KeepaliveResult {
  alive: number;
  dead: number;
  /** Sessions skipped because they have no canary EAN to verify against. */
  skipped: number;
  total: number;
}

/** Fetch the canary product with the cookie; return its data-price (or null). */
async function probePrice(cookie: string, ean: string): Promise<string | null> {
  const url =
    `https://${HOST}/products?currentUrl=p/${encodeURIComponent(ean)}` +
    `&method=getProductBasicData`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
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

/**
 * Touch every seeded Maxi Carrefour session (primary + fallback sucursales)
 * so PHP's idle-session GC doesn't reap them. Returns a tally of how many are
 * still alive, dead, or unverifiable (no canary).
 */
export async function runMaxiKeepalive(log: Logger = rootLogger): Promise<KeepaliveResult> {
  const { data: row, error } = await db
    .from('supermarkets')
    .select('config')
    .eq('id', 'maxi-carrefour')
    .single();
  if (error) {
    throw new Error(`maxi-keepalive: failed to read config: ${error.message}`);
  }

  const config = (row?.config ?? {}) as MaxiConfig;

  // Collect every seeded session: the primary cookie plus any fallback
  // sucursales in config.maxiSessions. Keep them ALL warm so the adapter's
  // multi-sucursal retry always has live cookies. Dedupe by cookie.
  const sessions: MaxiSession[] = [];
  const seen = new Set<string>();
  if (config.phpSessId) {
    sessions.push({ phpSessId: config.phpSessId, canaryEan: config.canaryEan, seller: 'primary' });
    seen.add(config.phpSessId);
  }
  for (const s of config.maxiSessions ?? []) {
    if (s?.phpSessId && !seen.has(s.phpSessId)) {
      sessions.push(s);
      seen.add(s.phpSessId);
    }
  }

  if (sessions.length === 0) {
    log.warn({}, 'maxi-keepalive: no sessions configured — nothing to keep warm');
    return { alive: 0, dead: 0, skipped: 0, total: 0 };
  }

  let alive = 0;
  let dead = 0;
  let skipped = 0;
  for (const session of sessions) {
    const cookie = session.phpSessId!;
    const canaryEan = session.canaryEan;
    if (!canaryEan) {
      skipped++;
      log.warn(
        { seller: session.seller },
        'maxi-keepalive: session has no canaryEan — cannot verify (re-seed to enable)',
      );
      continue;
    }

    // Touch the homepage first with the cookie. The product endpoint is a read;
    // the homepage does a full session_start and is more likely to re-write the
    // session (CSRF/flash state), refreshing its last-write time so PHP's GC
    // (mtime-based) doesn't reap it. Best-effort — ignore errors.
    await fetch(`https://${HOST}/`, {
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'es-AR,es;q=0.9',
        Cookie: `PHPSESSID=${cookie}`,
      },
    }).catch(() => undefined);

    const price = await probePrice(cookie, canaryEan);
    const isAlive = Boolean(price && price !== 'private' && price !== '');
    if (isAlive) {
      alive++;
      log.info({ seller: session.seller, canaryEan, price }, 'maxi-keepalive: session alive (kept warm)');
    } else {
      dead++;
      log.warn(
        { seller: session.seller, canaryEan, price: price ?? 'none' },
        'maxi-keepalive: session DEAD — re-seed from a residential IP ' +
          '(npx tsx --env-file=.env scripts/maxi-carrefour-login.ts --edge --headed "--probe=<eans>")',
      );
    }
  }

  log.info({ alive, dead, skipped, total: sessions.length }, 'maxi-keepalive: done');
  return { alive, dead, skipped, total: sessions.length };
}
