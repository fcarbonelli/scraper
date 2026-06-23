/**
 * Bulk product discovery: search a supermarket's site for all client EANs.
 *
 * For each EAN in the taxonomy catalog, calls the adapter's `searchByEan()`
 * method. When a product is found, it's automatically ingested (DB rows
 * created + taxonomy enriched) via the standard ingest pipeline.
 *
 * The search response includes the pre-resolved external ID (e.g. VTEX
 * productId), which is passed to the ingest pipeline so it skips the
 * extra pagetype HTTP call — only one request per EAN.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/discover-products.ts <supermarket-id>
 *   npx tsx --env-file=.env scripts/discover-products.ts carrefour
 *   npx tsx --env-file=.env scripts/discover-products.ts --search-only carrefour
 *
 * Options:
 *   --search-only  Search only, don't ingest. Shows which EANs would be added.
 *   --delay=N      Milliseconds between EANs (default: 1500). Be polite.
 *   --exclude=A,B  Skip these EANs entirely (e.g. to drop bad matches that a
 *                  review of `--search-only` output flagged as wrong).
 */

import { getAdapter } from '../src/adapters/registry.js';
import { TAXONOMY_BY_EAN } from '../src/shared/taxonomy.js';
import { ingestUrl } from '../src/ingest/index.js';
import { logger } from '../src/shared/logger.js';

const MAX_INGEST_RETRIES = 3;

interface DiscoverResult {
  found: string[];
  notFound: string[];
  alreadyExisted: string[];
  ingested: string[];
  errors: Array<{ ean: string; error: string }>;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const searchOnly = args.includes('--search-only');
  const delayArg = args.find((a) => a.startsWith('--delay='));
  const delay = delayArg ? parseInt(delayArg.split('=')[1] ?? '1500', 10) : 1500;
  const excludeArg = args.find((a) => a.startsWith('--exclude='));
  const excluded = new Set(
    (excludeArg?.split('=')[1] ?? '')
      .split(',')
      .map((s) => s.replace(/\D/g, ''))
      .filter(Boolean),
  );
  const supermarketId = args.filter((a) => !a.startsWith('--'))[0];

  if (!supermarketId) {
    console.error('Usage: discover-products.ts [--search-only] [--delay=1500] <supermarket-id>');
    console.error('');
    console.error('Available adapters with searchByEan:');
    const { listAdapters } = await import('../src/adapters/registry.js');
    for (const adapter of listAdapters()) {
      const hasSearch = typeof adapter.searchByEan === 'function';
      console.error(`  ${adapter.id.padEnd(20)} ${hasSearch ? '✓ searchByEan' : '✗ no search'}`);
    }
    process.exit(1);
  }

  const adapter = getAdapter(supermarketId);
  if (!adapter.searchByEan) {
    console.error(`Adapter "${supermarketId}" does not implement searchByEan().`);
    console.error('Only adapters with EAN search can be used for discovery.');
    process.exit(1);
  }

  const eans = Array.from(TAXONOMY_BY_EAN.keys());
  const total = eans.length;
  const result: DiscoverResult = {
    found: [],
    notFound: [],
    alreadyExisted: [],
    ingested: [],
    errors: [],
  };
  // ean → matched product URL, so --search-only can show what was matched
  // (essential for adapters whose matches aren't EAN-confirmed, e.g. Maxiconsumo).
  const foundUrls = new Map<string, string>();

  logger.info(
    { supermarket: supermarketId, totalEans: total, searchOnly, delay },
    'starting product discovery',
  );

  for (let i = 0; i < eans.length; i++) {
    const ean = eans[i]!;
    const taxonomy = TAXONOMY_BY_EAN.get(ean);
    const label = taxonomy?.descriptionForms ?? ean;
    const progress = `[${i + 1}/${total}]`;

    if (excluded.has(ean)) {
      logger.debug({ ean, progress }, 'excluded — skipping');
      continue;
    }

    try {
      const found = await adapter.searchByEan!(ean);

      if (!found) {
        result.notFound.push(ean);
        logger.debug({ ean, progress }, 'not found');
        if (delay > 0) await sleep(Math.min(delay, 300));
        continue;
      }

      result.found.push(ean);
      foundUrls.set(ean, found.url);
      logger.info({ ean, url: found.url, label, progress }, 'found product');

      if (!searchOnly) {
        const ingestOk = await ingestWithRetry(
          found.url,
          found.externalId,
          ean,
          progress,
        );
        if (ingestOk === 'existed') result.alreadyExisted.push(ean);
        else if (ingestOk === 'ingested') result.ingested.push(ean);
        else result.errors.push({ ean, error: ingestOk });
      }
    } catch (err) {
      result.errors.push({ ean, error: (err as Error).message });
      logger.warn({ ean, err: (err as Error).message, progress }, 'search failed');
    }

    if (delay > 0) await sleep(delay);
  }

  // Summary
  console.log('');
  console.log(`=== Discovery complete for ${supermarketId} ===`);
  console.log(`  Total EANs searched:  ${total}`);
  console.log(`  Found on site:        ${result.found.length}`);
  console.log(`  Not found:            ${result.notFound.length}`);
  if (searchOnly) {
    console.log(`  (search-only — nothing ingested)`);
  } else {
    console.log(`  Newly ingested:       ${result.ingested.length}`);
    console.log(`  Already in DB:        ${result.alreadyExisted.length}`);
  }
  console.log(`  Errors:               ${result.errors.length}`);

  if (result.errors.length > 0) {
    console.log('');
    console.log('Errors:');
    for (const e of result.errors) {
      console.log(`  ${e.ean}: ${e.error}`);
    }
  }

  if (searchOnly && result.found.length > 0) {
    console.log('');
    console.log('Found URLs (search-only — not ingested). Review each match:');
    for (const ean of result.found) {
      const tax = TAXONOMY_BY_EAN.get(ean);
      const desc = (tax?.descriptionForms ?? '').padEnd(34);
      console.log(`  ${ean}  ${desc}  ${foundUrls.get(ean) ?? ''}`);
    }
  }
}

/**
 * Ingest a URL with exponential backoff on 429 errors.
 * Returns 'ingested', 'existed', or an error message string.
 */
async function ingestWithRetry(
  url: string,
  externalId: string | undefined,
  ean: string,
  progress: string,
): Promise<'ingested' | 'existed' | string> {
  for (let attempt = 1; attempt <= MAX_INGEST_RETRIES; attempt++) {
    try {
      const ingested = await ingestUrl(url, {
        skipScrapeIfExists: true,
        runInitialScrape: false,
        preResolvedExternalId: externalId,
      });
      if (ingested.alreadyExisted) {
        logger.debug({ ean, progress }, 'already in DB');
        return 'existed';
      }
      return 'ingested';
    } catch (err) {
      const msg = (err as Error).message;
      const is429 = msg.includes('429') || msg.includes('rate');

      if (is429 && attempt < MAX_INGEST_RETRIES) {
        const backoff = 5_000 * Math.pow(2, attempt - 1); // 5s, 10s, 20s
        logger.info(
          { ean, attempt, backoffMs: backoff, progress },
          'rate limited on ingest, backing off',
        );
        await sleep(backoff);
        continue;
      }

      logger.warn({ ean, err: msg, attempt }, 'ingest failed');
      return `ingest failed: ${msg}`;
    }
  }
  return 'ingest failed: max retries exceeded';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void main();
