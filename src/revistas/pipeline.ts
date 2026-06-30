/**
 * Revista pipeline orchestration.
 *
 * For each "revista" supermarket (flagged via supermarkets.config.source_type),
 * on each daily run:
 *   1. CHEAP discovery of the current issue(s) → a dedup hash per issue.
 *   2. Skip any issue already processed (hash hit) → zero AI cost when nothing
 *      changed (the common case; magazines update every 1–2 weeks).
 *   3. For a NEW issue: download + render pages, read each with vision AI, match
 *      against the catalog, upload page images, and build the human review queue.
 *   4. Raise a `revista_review` alert so the operator sees it in the Daily Review.
 *
 * Nothing here publishes anything to the client — approval is a human step (see
 * src/revistas/approve.ts + the /v1/revistas API).
 */

import { z } from 'zod';
import { db } from '../shared/db.js';
import { logger, type Logger } from '../shared/logger.js';
import { captureError } from '../shared/sentry.js';
import { createAlert } from '../alerts/createAlert.js';
import { revistaConfig } from './config.js';
import { discoverCandidates, type MagazineCandidate } from './sources.js';
import type { PageSelection, RevistaStrategyConfig } from './sources-shared.js';
import { extractProductsFromPage, type ExtractedProduct } from './extract.js';
import { loadCatalog } from './catalog.js';
import { buildCatalogIndex, matchItems, type MatchResult } from './match.js';
import { mapPool } from './pool.js';
import { uploadPageImage } from './storage.js';
import {
  clearReviewItems,
  createMagazine,
  findMagazineByHash,
  insertReviewItems,
  setMagazineStatus,
  type ReviewItemInput,
} from './store.js';

const StrategySchema = z.object({
  strategy: z.enum(['html-pdf-links', 'pubhtml5', 'publuu']),
  offersUrl: z.string().url().optional(),
  pubhtml5Url: z.string().url().optional(),
});

const RevistaConfigSchema = z.object({
  source_type: z.literal('revista'),
  revista: StrategySchema,
});

export interface RevistaSupermarket {
  id: string;
  name: string;
  strategy: RevistaStrategyConfig;
}

/** Active supermarkets flagged as magazine-sourced (config.source_type='revista'). */
export async function loadRevistaSupermarkets(): Promise<RevistaSupermarket[]> {
  const { data, error } = await db
    .from('supermarkets')
    .select('id, name, is_active, config')
    .eq('is_active', true);
  if (error) throw error;

  const out: RevistaSupermarket[] = [];
  for (const row of data ?? []) {
    const parsed = RevistaConfigSchema.safeParse(row.config);
    if (!parsed.success) continue; // not a revista supermarket → skip
    out.push({ id: row.id as string, name: row.name as string, strategy: parsed.data.revista });
  }
  return out;
}

export interface ProcessOptions {
  scrapeRunId?: string | null;
  /** Restrict pages processed (1-based). Mainly for cheaper manual test runs. */
  pageSelection?: PageSelection;
  /** Reprocess even if the issue's hash already exists. */
  force?: boolean;
}

export interface MagazineSummary {
  supermarketId: string;
  label: string;
  status: 'skipped' | 'processed' | 'failed';
  hash: string;
  matched?: number;
  pages?: number;
  magazineId?: string;
  error?: string;
}

/** Run the full pipeline for ONE discovered candidate (already known to be new). */
async function processCandidate(
  sm: RevistaSupermarket,
  candidate: MagazineCandidate,
  opts: ProcessOptions,
  catalogIndexPromise: Promise<Awaited<ReturnType<typeof buildCatalogIndex>>>,
): Promise<MagazineSummary> {
  const log = logger.child({ supermarket: sm.id, magazine: candidate.label });
  log.info({ hash: candidate.hash }, 'revista: new issue, processing');

  const source = await candidate.fetch();
  const magazineId = await createMagazine({
    supermarketId: sm.id,
    label: candidate.label,
    strategy: sm.strategy.strategy,
    sourceUrl: candidate.sourceUrl,
    contentHash: candidate.hash,
    fileSize: source.fileSize,
    pageCount: source.pages.length,
    scrapeRunId: opts.scrapeRunId ?? null,
  });

  try {
    // 1. Vision: read every page (bounded concurrency).
    const perPage = await mapPages(source.pages, source.firstPage, log);
    const entries: { item: ExtractedProduct; page: number }[] = [];
    for (const { page, products } of perPage) {
      for (const item of products) entries.push({ item, page });
    }
    log.info({ extracted: entries.length, pages: source.pages.length }, 'revista: extraction done');

    // 2. Match against the catalog.
    const index = await catalogIndexPromise;
    const results = await matchItems(entries, index);
    const matched = results.filter((r) => r.matched);
    log.info({ matched: matched.length, total: results.length }, 'revista: matching done');

    // 3. Upload page images (only the pages that produced a queued match).
    const pageUrls = await uploadMatchedPages(magazineId, source, matched, log);

    // 4. Persist the review queue (matched items only — see REVISTA_REVIEW.md §6).
    const items: ReviewItemInput[] = matched.map((result) => ({
      result,
      pageImageUrl: pageUrls.get(result.page) ?? null,
    }));
    await clearReviewItems(magazineId); // idempotent reprocessing
    await insertReviewItems(magazineId, sm.id, items);

    // Keep the full extraction for future debugging (not exposed in v1).
    await db
      .from('revista_magazines')
      .update({ metadata: { extraction: perPage, matched: matched.length, total: results.length } })
      .eq('id', magazineId);

    await setMagazineStatus(magazineId, 'in_review');

    await createAlert({
      severity: 'info',
      type: 'revista_review',
      supermarketId: sm.id,
      title: `Nueva revista de ${sm.name} para revisar`,
      message: `Se detectó una nueva revista (${candidate.label}). La IA encontró ${matched.length} producto(s) para revisar.`,
      context: { magazine_id: magazineId, matched: matched.length, pages: source.pages.length },
    });

    return {
      supermarketId: sm.id,
      label: candidate.label,
      status: 'processed',
      hash: candidate.hash,
      matched: matched.length,
      pages: source.pages.length,
      magazineId,
    };
  } catch (err) {
    // Leave the magazine row in 'processing' so a later run retries it.
    log.error({ err }, 'revista: processing failed');
    captureError(err, { supermarket: sm.id, magazine: candidate.label });
    return {
      supermarketId: sm.id,
      label: candidate.label,
      status: 'failed',
      hash: candidate.hash,
      magazineId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Vision over all pages with bounded concurrency, preserving real page numbers. */
async function mapPages(
  pages: Buffer[],
  firstPage: number,
  log: Logger,
): Promise<{ page: number; products: ExtractedProduct[] }[]> {
  return mapPool(pages, revistaConfig.concurrency, async (img, i) => {
    const page = firstPage + i;
    try {
      const products = await extractProductsFromPage(img, page);
      return { page, products };
    } catch (err) {
      log.warn({ err, page }, 'revista: page extraction failed, skipping page');
      return { page, products: [] as ExtractedProduct[] };
    }
  });
}

/** Upload the image of each page that yielded a queued match (deduped per page). */
async function uploadMatchedPages(
  magazineId: string,
  source: Awaited<ReturnType<MagazineCandidate['fetch']>>,
  matched: MatchResult[],
  log: Logger,
): Promise<Map<number, string>> {
  const urls = new Map<number, string>();
  const wantedPages = [...new Set(matched.map((m) => m.page))];
  for (const page of wantedPages) {
    const idx = page - source.firstPage;
    const img = source.pages[idx];
    if (!img) continue;
    const url = await uploadPageImage(magazineId, page, img);
    if (url) urls.set(page, url);
    else log.warn({ page }, 'revista: page image upload returned no URL');
  }
  return urls;
}

/** Process one supermarket: discover, dedup, and process any new issues. */
export async function processSupermarket(
  sm: RevistaSupermarket,
  opts: ProcessOptions = {},
  catalogIndexPromise?: Promise<Awaited<ReturnType<typeof buildCatalogIndex>>>,
): Promise<MagazineSummary[]> {
  const log = logger.child({ supermarket: sm.id });
  let candidates: MagazineCandidate[];
  try {
    candidates = await discoverCandidates(sm.strategy, opts.pageSelection);
  } catch (err) {
    log.error({ err }, 'revista: discovery failed');
    captureError(err, { supermarket: sm.id, phase: 'discover' });
    return [{ supermarketId: sm.id, label: '(discovery)', status: 'failed', hash: '', error: err instanceof Error ? err.message : String(err) }];
  }

  // Decide which candidates actually need (expensive) processing.
  const toProcess: MagazineCandidate[] = [];
  const summaries: MagazineSummary[] = [];
  for (const c of candidates) {
    const existing = await findMagazineByHash(sm.id, c.hash);
    if (existing && existing.status !== 'processing' && !opts.force) {
      summaries.push({ supermarketId: sm.id, label: c.label, status: 'skipped', hash: c.hash, magazineId: existing.id });
      continue;
    }
    toProcess.push(c);
  }

  if (toProcess.length === 0) {
    log.info({ candidates: candidates.length }, 'revista: nothing changed, skipping');
    return summaries;
  }

  // Build the catalog index once per supermarket (shared across its issues).
  const indexPromise = catalogIndexPromise ?? loadCatalog().then(buildCatalogIndex);
  for (const c of toProcess) {
    summaries.push(await processCandidate(sm, c, opts, indexPromise));
  }
  return summaries;
}

/**
 * Daily entry point: check every revista supermarket. Called by the orchestrator
 * after the normal scrape is enqueued. Safe to call manually too.
 */
export async function runRevistaCheck(opts: ProcessOptions = {}): Promise<MagazineSummary[]> {
  if (!revistaConfig.enabled) {
    logger.info('revista: disabled via REVISTA_ENABLED=false, skipping');
    return [];
  }
  if (!revistaConfig.openaiApiKey) {
    logger.warn('revista: OPENAI_API_KEY not set, skipping magazine check');
    return [];
  }

  const supers = await loadRevistaSupermarkets();
  if (supers.length === 0) {
    logger.info('revista: no magazine-sourced supermarkets configured');
    return [];
  }
  logger.info({ count: supers.length }, 'revista: checking magazines');

  // The catalog is the same for every supermarket — build the index once.
  const indexPromise = loadCatalog().then(buildCatalogIndex);

  const all: MagazineSummary[] = [];
  for (const sm of supers) {
    const summaries = await processSupermarket(sm, opts, indexPromise);
    all.push(...summaries);
  }

  const processed = all.filter((s) => s.status === 'processed').length;
  const skipped = all.filter((s) => s.status === 'skipped').length;
  const failed = all.filter((s) => s.status === 'failed').length;
  logger.info({ processed, skipped, failed }, 'revista: check complete');
  return all;
}
