/**
 * Reusable EAN-discovery core.
 *
 * Given an EAN and a supermarket, calls the adapter's `searchByEan()` and — if
 * found — ingests it via the standard pipeline (rows created, taxonomy
 * enriched, no initial scrape; the next scheduled run captures the price).
 *
 * Shared by:
 *   - the async discovery worker (src/worker/discoveryWorker.ts, driving the
 *     POST /v1/data/discover endpoint)
 *   - scripts/discover-products.ts (the CLI)
 *
 * "Not found" and "no search support" are NORMAL outcomes, not errors — they
 * are reported in the result, never thrown. Only genuine failures throw.
 */

import { getAdapter, listAdapters } from '../adapters/registry.js';
import { getCatalogEans } from '../shared/catalog.js';
import { ingestUrl } from '../ingest/index.js';
import { logger } from '../shared/logger.js';

/** Outcome of discovering one EAN at one supermarket. */
export type DiscoverResultKind =
  | 'ingested'   // found + newly added to the DB
  | 'existed'    // found but already mapped
  | 'not_found'  // searched, product absent at this chain
  | 'no_search'  // chain has no searchByEan — needs a manual URL
  | 'error';     // search or ingest failed

export interface DiscoverOutcome {
  ean: string;
  supermarketId: string;
  result: DiscoverResultKind;
  url?: string;
  error?: string;
}

const INGEST_MAX_RETRIES = 3;

/**
 * Discover one EAN at one supermarket. Never throws — failures are captured
 * in the returned outcome so a fan-out loop keeps going.
 */
export async function discoverEanAtSupermarket(
  ean: string,
  supermarketId: string,
): Promise<DiscoverOutcome> {
  let adapter;
  try {
    adapter = getAdapter(supermarketId);
  } catch (err) {
    return { ean, supermarketId, result: 'error', error: (err as Error).message };
  }

  if (typeof adapter.searchByEan !== 'function') {
    return { ean, supermarketId, result: 'no_search' };
  }

  const log = logger.child({ ean, supermarket: supermarketId });

  try {
    const found = await adapter.searchByEan(ean);
    if (!found) return { ean, supermarketId, result: 'not_found' };

    const ingested = await ingestWithRetry(found.url, found.externalId, ean);
    log.info({ url: found.url, result: ingested }, 'discovery matched product');
    return { ean, supermarketId, result: ingested, url: found.url };
  } catch (err) {
    const message = (err as Error).message;
    log.warn({ err: message }, 'discovery failed');
    return { ean, supermarketId, result: 'error', error: message };
  }
}

/**
 * Discover one EAN across EVERY supermarket whose adapter supports EAN search.
 * The main path behind "I just added a new EAN". Sequential with a small delay
 * so we stay polite to each site.
 */
export async function discoverEanEverywhere(
  ean: string,
  delayMs = 1500,
  onProgress?: (o: DiscoverOutcome) => void,
): Promise<DiscoverOutcome[]> {
  const targets = adaptersWithSearch();
  const outcomes: DiscoverOutcome[] = [];
  for (const id of targets) {
    const outcome = await discoverEanAtSupermarket(ean, id);
    outcomes.push(outcome);
    onProgress?.(outcome);
    if (delayMs > 0) await sleep(delayMs);
  }
  return outcomes;
}

/**
 * Discover ALL catalog EANs at one supermarket (the CLI's historical
 * behavior). Skips chains without search support.
 */
export async function discoverAllEansAtSupermarket(
  supermarketId: string,
  delayMs = 1500,
  onProgress?: (o: DiscoverOutcome) => void,
): Promise<DiscoverOutcome[]> {
  const catalog = await getCatalogEans();
  const eans = Array.from(catalog.keys());
  const outcomes: DiscoverOutcome[] = [];
  for (const ean of eans) {
    const outcome = await discoverEanAtSupermarket(ean, supermarketId);
    outcomes.push(outcome);
    onProgress?.(outcome);
    // Poll less between misses; be politely slow after a hit.
    const gap = outcome.result === 'not_found' ? Math.min(delayMs, 300) : delayMs;
    if (gap > 0) await sleep(gap);
  }
  return outcomes;
}

/** Ids of every registered adapter that implements searchByEan. */
export function adaptersWithSearch(): string[] {
  return listAdapters()
    .filter((a) => typeof a.searchByEan === 'function')
    .map((a) => a.id);
}

/** Ingest a found URL, retrying with backoff on rate-limit (429) errors. */
async function ingestWithRetry(
  url: string,
  externalId: string | undefined,
  ean: string,
): Promise<'ingested' | 'existed' | 'error'> {
  for (let attempt = 1; attempt <= INGEST_MAX_RETRIES; attempt++) {
    try {
      const ingested = await ingestUrl(url, {
        skipScrapeIfExists: true,
        runInitialScrape: false,
        preResolvedExternalId: externalId,
        ean,
      });
      return ingested.alreadyExisted ? 'existed' : 'ingested';
    } catch (err) {
      const msg = (err as Error).message;
      const is429 = msg.includes('429') || msg.toLowerCase().includes('rate');
      if (is429 && attempt < INGEST_MAX_RETRIES) {
        const backoff = 5_000 * Math.pow(2, attempt - 1); // 5s, 10s, 20s
        logger.info({ ean, attempt, backoffMs: backoff }, 'rate limited on ingest, backing off');
        await sleep(backoff);
        continue;
      }
      throw err;
    }
  }
  return 'error';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
