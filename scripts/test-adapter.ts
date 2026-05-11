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
 *
 * Env required: only NODE_ENV (defaults to "development"). DB/Redis/Telegram
 * env vars are read by the shared modules but not required for this script.
 */

import { logger } from '../src/shared/logger.js';
import { getAdapter } from '../src/adapters/registry.js';
import { detectSupermarket } from '../src/ingest/index.js';
import type { ScrapeContext, SupermarketConfig } from '../src/adapters/types.js';

const DEFAULT_URL =
  'https://www.cotodigital.com.ar/sitios/cdigi/productos/lavandina-original-ayudin-2l/_/R-00591050-00591050-200';

async function main(): Promise<void> {
  const url = process.argv[2] ?? DEFAULT_URL;

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
  } catch (err) {
    logger.error({ err }, 'scrape failed');
    process.exitCode = 1;
  }
}

void main();
