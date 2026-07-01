/**
 * Bulk product discovery (CLI).
 *
 * Thin wrapper over the shared discovery core (`src/discovery/index.ts`) — the
 * same code path the async POST /v1/data/discover endpoint uses. For each
 * catalog EAN, calls the adapter's `searchByEan()` and ingests matches.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/discover-products.ts <supermarket-id>
 *   npx tsx --env-file=.env scripts/discover-products.ts carrefour
 *   npx tsx --env-file=.env scripts/discover-products.ts --search-only carrefour
 *   npx tsx --env-file=.env scripts/discover-products.ts --ean=779... carrefour
 *
 * Options:
 *   --search-only  Search only, don't ingest. Shows which EANs would be added.
 *   --delay=N      Milliseconds between EANs (default: 1500). Be polite.
 *   --exclude=A,B  Skip these EANs entirely.
 *   --ean=E        Discover a single EAN at this supermarket (skips the loop).
 */

import { getAdapter } from '../src/adapters/registry.js';
import { getCatalogEans } from '../src/shared/catalog.js';
import {
  discoverEanAtSupermarket,
  type DiscoverOutcome,
} from '../src/discovery/index.js';
import { logger } from '../src/shared/logger.js';

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
  const eanArg = args.find((a) => a.startsWith('--ean='));
  const singleEan = eanArg?.split('=')[1]?.replace(/\D/g, '') || null;
  const supermarketId = args.filter((a) => !a.startsWith('--'))[0];

  if (!supermarketId) {
    console.error('Usage: discover-products.ts [--search-only] [--delay=1500] [--ean=E] <supermarket-id>');
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
    process.exit(1);
  }

  const catalog = await getCatalogEans();
  const eans = singleEan ? [singleEan] : Array.from(catalog.keys());
  const total = eans.length;

  const outcomes: DiscoverOutcome[] = [];
  logger.info({ supermarket: supermarketId, totalEans: total, searchOnly, delay }, 'starting product discovery');

  for (let i = 0; i < eans.length; i++) {
    const ean = eans[i]!;
    const progress = `[${i + 1}/${total}]`;
    if (excluded.has(ean)) {
      logger.debug({ ean, progress }, 'excluded — skipping');
      continue;
    }

    // --search-only never ingests: probe searchByEan directly.
    if (searchOnly) {
      try {
        const found = await adapter.searchByEan!(ean);
        outcomes.push({
          ean,
          supermarketId,
          result: found ? 'ingested' : 'not_found', // "ingested" here == "found"
          url: found?.url,
        });
        if (found) logger.info({ ean, url: found.url, progress }, 'found product');
      } catch (err) {
        outcomes.push({ ean, supermarketId, result: 'error', error: (err as Error).message });
      }
      if (delay > 0) await sleep(Math.min(delay, 300));
      continue;
    }

    const outcome = await discoverEanAtSupermarket(ean, supermarketId);
    outcomes.push(outcome);
    const gap = outcome.result === 'not_found' ? Math.min(delay, 300) : delay;
    if (gap > 0) await sleep(gap);
  }

  printSummary(supermarketId, outcomes, total, searchOnly);
}

function printSummary(
  supermarketId: string,
  outcomes: DiscoverOutcome[],
  total: number,
  searchOnly: boolean,
): void {
  const found = outcomes.filter((o) => o.result === 'ingested' || o.result === 'existed');
  const ingested = outcomes.filter((o) => o.result === 'ingested');
  const existed = outcomes.filter((o) => o.result === 'existed');
  const notFound = outcomes.filter((o) => o.result === 'not_found' || o.result === 'no_search');
  const errors = outcomes.filter((o) => o.result === 'error');

  console.log('');
  console.log(`=== Discovery complete for ${supermarketId} ===`);
  console.log(`  Total EANs searched:  ${total}`);
  console.log(`  Found on site:        ${found.length}`);
  console.log(`  Not found:            ${notFound.length}`);
  if (searchOnly) {
    console.log(`  (search-only — nothing ingested)`);
  } else {
    console.log(`  Newly ingested:       ${ingested.length}`);
    console.log(`  Already in DB:        ${existed.length}`);
  }
  console.log(`  Errors:               ${errors.length}`);

  if (errors.length > 0) {
    console.log('');
    console.log('Errors:');
    for (const e of errors) console.log(`  ${e.ean}: ${e.error}`);
  }

  if (searchOnly && found.length > 0) {
    console.log('');
    console.log('Found URLs (search-only — not ingested). Review each match:');
    for (const o of found) console.log(`  ${o.ean}  ${o.url ?? ''}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void main();
