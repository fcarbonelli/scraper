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
import { buildCatalogIndex, matchItems } from './match.js';
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

  // Everything below (download, create, vision, match, upload) is inside the
  // try so ANY failure for one issue is contained: we return a 'failed' summary
  // and move on to the next issue/chain instead of aborting the whole run.
  let magazineId: string | undefined;
  try {
    const source = await candidate.fetch();
    magazineId = await createMagazine({
      supermarketId: sm.id,
      label: candidate.label,
      strategy: sm.strategy.strategy,
      sourceUrl: candidate.sourceUrl,
      contentHash: candidate.hash,
      fileSize: source.fileSize,
      pageCount: source.pages.length,
      scrapeRunId: opts.scrapeRunId ?? null,
    });

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

    // 3. Upload EVERY page image (not just matched pages) so the review/analyze
    //    UI can always show the full magazine — even when nothing matched.
    const pageUrls = await uploadAllPages(magazineId, source, log);

    // 4. Persist the review queue (auto-matched items — the ones an operator
    //    approves/rejects). Unmatched items live in metadata.analysis below.
    const items: ReviewItemInput[] = matched.map((result) => ({
      result,
      pageImageUrl: pageUrls.get(result.page) ?? null,
    }));
    await clearReviewItems(magazineId); // idempotent reprocessing
    await insertReviewItems(magazineId, sm.id, items);

    // 5. Persist the FULL analysis (every extracted product + why it did/didn't
    //    match) and all page-image URLs, so the debug/analyze view can show what
    //    the AI actually saw. This is the key diagnostic for "0 matched".
    await db
      .from('revista_magazines')
      .update({
        metadata: {
          matched: matched.length,
          total: results.length,
          page_images: [...pageUrls.entries()]
            .map(([page, url]) => ({ page, url }))
            .sort((a, b) => a.page - b.page),
          analysis: results.map((r) => ({
            page: r.page,
            extracted: {
              name: r.item.name,
              brand: r.item.brand,
              ean: r.item.ean,
              price: r.item.price,
              promo_price: r.item.promo_price,
              promo_text: r.item.promo_text,
              quantity: r.item.quantity,
            },
            matched: Boolean(r.matched),
            method: r.method,
            confidence: r.confidence,
            reason: r.reason,
            matched_product_id: r.matched?.id ?? null,
            top_candidates: r.candidates.slice(0, 3).map((c) => ({ id: c.id, name: c.name, brand: c.brand ?? null })),
          })),
        },
      })
      .eq('id', magazineId);

    await setMagazineStatus(magazineId, 'in_review');

    await createAlert({
      severity: 'info',
      type: 'revista_review',
      supermarketId: sm.id,
      title: `Nueva revista de ${sm.name} para revisar`,
      message: `Se detectó una nueva revista (${candidate.label}). La IA leyó ${results.length} producto(s), ${matched.length} con match para revisar.`,
      context: { magazine_id: magazineId, matched: matched.length, extracted: results.length, pages: source.pages.length },
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
    // Leave the magazine row (if created) in 'processing' so a later run retries.
    log.error({ err }, 'revista: processing failed');
    captureError(err, { supermarket: sm.id, magazine: candidate.label });
    return {
      supermarketId: sm.id,
      label: candidate.label,
      status: 'failed',
      hash: candidate.hash,
      ...(magazineId ? { magazineId } : {}),
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

/** Upload EVERY page image so the review/analyze UI can show the full magazine. */
async function uploadAllPages(
  magazineId: string,
  source: Awaited<ReturnType<MagazineCandidate['fetch']>>,
  log: Logger,
): Promise<Map<number, string>> {
  const urls = new Map<number, string>();
  for (let i = 0; i < source.pages.length; i++) {
    const page = source.firstPage + i;
    const img = source.pages[i];
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
