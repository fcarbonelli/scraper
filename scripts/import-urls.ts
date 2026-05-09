/**
 * Bulk URL importer.
 *
 * Reads a list of product URLs from a text file (one per line, blank lines
 * and `#` comments ignored), and ingests each into the system: creates
 * `products` + `supermarket_products` rows and runs a first price scrape.
 *
 * Idempotent — URLs already in the DB are skipped (no duplicate row, no
 * extra scrape). Re-run the file as many times as you like.
 *
 * Usage:
 *   npm run scrape:bulk -- <file.txt>
 *   npm run scrape:bulk -- <file.txt> --rescrape   # also rescrape existing URLs
 *
 * Example file (urls.txt):
 *   # Coto
 *   https://www.cotodigital.com.ar/sitios/cdigi/productos/foo/_/R-00591050-...
 *
 *   # Carrefour
 *   https://www.carrefour.com.ar/foo/p
 *   https://www.carrefour.com.ar/bar/p
 *
 * The script logs per-URL outcomes plus a final summary
 * (imported / skipped / failed). Exits non-zero if any URL failed, so it's
 * safe to wire into CI.
 */

import { readFileSync } from 'node:fs';
import { logger } from '../src/shared/logger.js';
import { ingestUrl } from '../src/ingest/index.js';

/** Polite delay between requests so we don't hammer the supermarket sites. */
const DELAY_BETWEEN_URLS_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Read a URL list file, stripping blanks and `#` comments. */
function parseUrlFile(path: string): string[] {
  const text = readFileSync(path, 'utf8');
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

interface Counts {
  total: number;
  imported: number;
  skipped: number;
  failed: number;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const fileArg = args.find((a) => !a.startsWith('--'));
  const rescrape = args.includes('--rescrape');

  if (!fileArg) {
    logger.fatal('Usage: npm run scrape:bulk -- <file.txt> [--rescrape]');
    process.exit(1);
  }

  let urls: string[];
  try {
    urls = parseUrlFile(fileArg);
  } catch (err) {
    logger.fatal({ err, file: fileArg }, 'failed to read URL file');
    process.exit(1);
  }

  if (urls.length === 0) {
    logger.warn({ file: fileArg }, 'no URLs found in file (only blanks/comments)');
    return;
  }

  logger.info({ file: fileArg, count: urls.length, rescrape }, 'starting bulk import');
  const counts: Counts = { total: urls.length, imported: 0, skipped: 0, failed: 0 };
  const failures: Array<{ url: string; error: string }> = [];

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i]!;
    const log = logger.child({ index: i + 1, total: urls.length });

    try {
      const result = await ingestUrl(url, { skipScrapeIfExists: !rescrape });

      if (result.alreadyExisted && !rescrape) {
        counts.skipped++;
        log.info(
          { url, externalId: result.externalId },
          'already imported, skipped (use --rescrape to refresh)',
        );
      } else if (result.scrape?.status === 'success') {
        counts.imported++;
        log.info(
          { url, supermarketId: result.supermarketId, externalId: result.externalId },
          result.alreadyExisted ? 'rescraped existing URL' : 'imported new URL',
        );
      } else {
        // Row was created (or already existed) but the price scrape did not
        // succeed — surface as a failure so the user can investigate.
        counts.failed++;
        const reason = result.scrape?.status ?? 'no-scrape';
        failures.push({ url, error: `scrape: ${reason}` });
        log.warn(
          { url, scrape: result.scrape },
          'imported row but initial scrape did not succeed',
        );
      }
    } catch (err) {
      counts.failed++;
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ url, error: message });
      log.error({ err, url }, 'ingest failed');
    }

    // Polite delay before the next URL (skip the wait after the final one).
    if (i < urls.length - 1) await sleep(DELAY_BETWEEN_URLS_MS);
  }

  logger.info(counts, 'bulk import complete');
  if (failures.length > 0) {
    logger.warn({ failures }, 'failures encountered');
    process.exitCode = 1;
  }
}

void main().catch((err: unknown) => {
  logger.fatal({ err }, 'bulk import crashed');
  process.exitCode = 1;
});
