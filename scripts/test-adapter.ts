/**
 * Adapter smoke test (no database / queue required).
 *
 * Hits the live Coto JSON endpoint with one URL and prints what the adapter
 * extracts. Useful for verifying parsing logic and seeing what real data
 * looks like.
 *
 * Usage:
 *   npx tsx scripts/test-adapter.ts
 *   npx tsx scripts/test-adapter.ts <product-url>
 *
 * Env required: only NODE_ENV (defaults to "development"). DB/Redis/Telegram
 * env vars are read by the shared modules but not required for this script
 * because we bypass DB persistence here.
 */

import { logger } from '../src/shared/logger.js';
import { cotoAdapter } from '../src/adapters/coto.js';
import type { ScrapeContext } from '../src/adapters/types.js';

const DEFAULT_URL =
  'https://www.cotodigital.com.ar/sitios/cdigi/productos/lavandina-original-ayudin-2l/_/R-00591050-00591050-200';

async function main(): Promise<void> {
  const url = process.argv[2] ?? DEFAULT_URL;

  logger.info({ url }, 'running Coto adapter smoke test');

  const ctx: ScrapeContext = {
    supermarketProductId: 'test-fake-uuid',
    externalId: 'test-external',
    externalUrl: url,
    config: {
      id: 'coto',
      name: 'Coto',
      baseUrl: 'https://www.cotodigital.com.ar',
      rateLimitMs: 0,
      concurrency: 1,
      config: {},
    },
    logger: logger.child({ supermarket: 'coto' }),
  };

  const start = Date.now();
  try {
    const result = await cotoAdapter.scrape(ctx);
    const durationMs = Date.now() - start;

    // Hide the (large) raw_data attribute bag from the printout but show its
    // size so we can sanity-check we collected it.
    const rawSize = JSON.stringify(result.rawData ?? {}).length;
    const display = { ...result, rawData: `[${rawSize} bytes captured]` };

    logger.info({ durationMs }, 'scrape ok');
    // Use console for human-readable structured output here so the values
    // aren't truncated by the logger.
    console.log('\n--- ScrapeResult ---');
    console.log(JSON.stringify(display, null, 2));
  } catch (err) {
    logger.error({ err }, 'scrape failed');
    process.exitCode = 1;
  }
}

void main();
