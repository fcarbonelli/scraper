/**
 * One-shot end-to-end scrape for a single product URL.
 *
 * Bypasses Redis/BullMQ — calls the adapter and processJob directly so it's
 * the simplest way to verify the full pipeline (adapter -> DB) works.
 *
 *   - If the URL is already imported, it's still rescraped (the user asked
 *     for a fresh snapshot by running this command).
 *   - If new, the adapter is probed once to seed `products` /
 *     `supermarket_products`, then a price snapshot is taken.
 *
 * Usage:
 *   npm run scrape:url -- <product-url>
 *   npm run scrape:url                   # uses the default Coto URL below
 *
 * For importing many URLs at once, see `npm run scrape:bulk`.
 */

import { logger } from '../src/shared/logger.js';
import { ingestUrl } from '../src/ingest/index.js';

const DEFAULT_URL =
  'https://www.cotodigital.com.ar/sitios/cdigi/productos/lavandina-original-ayudin-2l/_/R-00591050-00591050-200';

async function main(): Promise<void> {
  const url = process.argv[2] ?? DEFAULT_URL;
  logger.info({ url }, 'starting one-shot scrape');

  // skipScrapeIfExists: false — single-URL command always rescrapes,
  // because the user explicitly asked for a fresh snapshot.
  const result = await ingestUrl(url, { skipScrapeIfExists: false });

  logger.info(
    {
      supermarketProductId: result.supermarketProductId,
      externalId: result.externalId,
      alreadyExisted: result.alreadyExisted,
      scrape: result.scrape,
    },
    'done',
  );
  if (result.scrape?.status !== 'success') process.exitCode = 1;
}

void main().catch((err: unknown) => {
  logger.fatal({ err }, 'scrape-url failed');
  process.exitCode = 1;
});
