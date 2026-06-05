/**
 * Adapter smoke test (no database / queue required).
 *
 * Pass any product URL — the script auto-detects the supermarket by hostname
 * and runs that adapter's `canonicalizeUrl` → `resolveExternalId` → `scrape`
 * cycle, then prints the ScrapeResult. No DB writes, no queue, no Telegram.
 *
 * Useful for:
 *   - Verifying a new adapter parses real data correctly.
 *   - Re-checking an adapter after a site changes (selector_failed alerts).
 *   - One-off sanity checks of any product URL during dev.
 *
 * Usage:
 *   npm run test:adapter                                    # default Coto URL
 *   npm run test:adapter -- <product-url>                   # any adapter
 *   npm run test:adapter -- <product-url> --all-zones       # VTEX geo diagnostic
 *
 * `--all-zones` (Carrefour / any VTEX store): after the normal scrape, probes
 * the product across every zone in DEFAULT_ZONES and prints an availability
 * table — handy for diagnosing "missing / out of stock" products that turn out
 * to be regionalized.
 *
 * Env required: only NODE_ENV (defaults to "development"). DB/Redis/Telegram
 * env vars are read by the shared modules but not required for this script.
 */

import { logger } from '../src/shared/logger.js';
import { getAdapter } from '../src/adapters/registry.js';
import { detectSupermarket } from '../src/ingest/index.js';
import type { ScrapeContext, SupermarketConfig } from '../src/adapters/types.js';
import { DEFAULT_ZONES } from '../src/adapters/zones.js';
import { resolveRegionId, withRegion } from '../src/adapters/vtex-region.js';
import { parseCarrefourResponse } from '../src/adapters/carrefour.js';

const DEFAULT_URL =
  'https://www.cotodigital.com.ar/sitios/cdigi/productos/lavandina-original-ayudin-2l/_/R-00591050-00591050-200';

async function main(): Promise<void> {
  // First non-flag argument is the URL; flags start with "--".
  const args = process.argv.slice(2);
  const allZones = args.includes('--all-zones');
  const url = args.find((a) => !a.startsWith('--')) ?? DEFAULT_URL;

  const supermarketId = detectSupermarket(url);
  const adapter = getAdapter(supermarketId);
  logger.info({ url, supermarket: supermarketId }, 'running adapter smoke test');

  // canonicalize + resolve external_id like the real ingest path does
  const canonicalUrl = adapter.canonicalizeUrl ? adapter.canonicalizeUrl(url) : url;
  const externalId = adapter.resolveExternalId
    ? await adapter.resolveExternalId(canonicalUrl)
    : new URL(canonicalUrl).pathname;

  // Mock SupermarketConfig — adapters that need DB-driven config (e.g.
  // maxi-carrefour's PHPSESSID) will fall back to the env var here.
  const config: SupermarketConfig = {
    id: supermarketId,
    name: supermarketId,
    baseUrl: null,
    rateLimitMs: 0,
    concurrency: 1,
    config: {},
  };

  const ctx: ScrapeContext = {
    supermarketProductId: 'test-fake-uuid',
    externalId,
    externalUrl: canonicalUrl,
    config,
    logger: logger.child({ supermarket: supermarketId, externalId }),
  };

  const start = Date.now();
  try {
    const result = await adapter.scrape(ctx);
    const durationMs = Date.now() - start;

    // Trim raw_data from the printout (can be very large) but show its size
    // so we can sanity-check we collected it.
    const rawSize = JSON.stringify(result.rawData ?? {}).length;
    const display = { ...result, rawData: `[${rawSize} bytes captured]` };

    logger.info({ durationMs, externalId, canonicalUrl }, 'scrape ok');
    // Use console for human-readable structured output so values aren't
    // truncated by the logger.
    console.log('\n--- ScrapeResult ---');
    console.log(JSON.stringify(display, null, 2));

    if (allZones) {
      await probeAllZones(supermarketId, externalId);
    }
  } catch (err) {
    logger.error({ err }, 'scrape failed');
    process.exitCode = 1;
  }
}

const CARREFOUR_BASE = 'https://www.carrefour.com.ar';

/**
 * Probe a VTEX product across every zone in DEFAULT_ZONES and print an
 * availability table. Diagnostic only — does not touch the DB.
 */
async function probeAllZones(
  supermarketId: string,
  externalId: string,
): Promise<void> {
  if (supermarketId !== 'carrefour') {
    logger.warn(
      { supermarketId },
      '--all-zones is only supported for VTEX stores (carrefour) right now',
    );
    return;
  }

  console.log('\n--- Zone availability (Carrefour / VTEX) ---');
  for (const zone of DEFAULT_ZONES) {
    const label = `${zone.id.padEnd(16)} CP ${zone.postalCode}`;
    const regionId = await resolveRegionId(CARREFOUR_BASE, zone.postalCode);
    if (!regionId) {
      console.log(`${label}  -> no region serves this CP`);
      continue;
    }
    const url = withRegion(
      `${CARREFOUR_BASE}/api/catalog_system/pub/products/search?fq=productId:${encodeURIComponent(
        externalId,
      )}`,
      regionId,
    );
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
      });
      const body = (await res.json()) as Parameters<typeof parseCarrefourResponse>[0];
      const result = parseCarrefourResponse(body, { externalId, logger });
      console.log(`${label}  -> inStock=${result.inStock} price=${result.price}`);
    } catch (err) {
      console.log(`${label}  -> ${(err as Error).message}`);
    }
  }
}

void main();
