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
import { discoverCandidates, candidateFromPdfUrl, type MagazineCandidate } from './sources.js';
import type { PageSelection, RevistaStrategyConfig } from './sources-shared.js';
import { extractProductsFromPage, type ExtractedProduct } from './extract.js';
import { loadCatalog } from './catalog.js';
import { buildCatalogIndex, matchItems } from './match.js';
import { mapPool, withTimeout } from './pool.js';
import { recordRevistaCheck } from './checkLog.js';
import { uploadPageImage } from './storage.js';
import {
  clearReviewItems,
  createMagazine,
  findCurrentMagazineInSeries,
  findMagazineByHash,
  insertReviewItems,
  setMagazineStatus,
  supersedePreviousMagazines,
  type MagazineRow,
  type ReviewItemInput,
} from './store.js';
import { classifyReupload, shouldProcessSeries, wouldProcess } from './decide.js';
import { parseFlyerPeriod, type FlyerPeriod } from './period.js';
import { purgeTodayRevistaSnapshotsNotApprovedOn, pauseSupersededSeriesMappings } from './approve.js';

const StrategySchema = z.object({
  strategy: z.enum(['html-pdf-links', 'pubhtml5', 'publuu']),
  offersUrl: z.string().url().optional(),
  pubhtml5Url: z.string().url().optional(),
  /** Flyer series to ignore at discovery (e.g. ['gt']). Empty = process all. */
  skipSeries: z.array(z.string().min(1)).optional(),
});

const RevistaConfigSchema = z.object({
  source_type: z.literal('revista'),
  revista: StrategySchema,
});

export interface RevistaSupermarket {
  id: string;
  name: string;
  strategy: RevistaStrategyConfig;
  /** From config.revista.skipSeries — never process these series keys. */
  skipSeries: string[];
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
    out.push({
      id: row.id as string,
      name: row.name as string,
      strategy: parsed.data.revista,
      skipSeries: parsed.data.revista.skipSeries ?? [],
    });
  }
  return out;
}

export interface ProcessOptions {
  scrapeRunId?: string | null;
  /** Restrict pages processed (1-based). Mainly for cheaper manual test runs. */
  pageSelection?: PageSelection;
  /** Reprocess even if the issue's hash already exists. */
  force?: boolean;
  /**
   * Extra series keys to skip (CLI). Merged with config.revista.skipSeries.
   * Ignored when `onlySeries` is set.
   */
  skipSeries?: string[];
  /** If set, ONLY these series keys are processed (CLI override). */
  onlySeries?: string[];
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
      seriesKey: candidate.seriesKey,
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
            matched_ean: r.matched?.ean ?? r.matched?.id ?? null,
            top_candidates: r.candidates.slice(0, 3).map((c) => ({
              ean: c.ean ?? c.id,
              name: c.name,
              brand: c.brand ?? null,
            })),
          })),
        },
      })
      .eq('id', magazineId);

    await setMagazineStatus(magazineId, 'in_review');

    // New issue supersedes prior magazines of the SAME SERIES: stop carrying
    // that series' old prices and clear today's export until a human approves B.
    // Other concurrent series (e.g. Makro GT while MM just arrived) are untouched.
    const superseded = await supersedePreviousMagazines(sm.id, magazineId);
    if (superseded.length > 0) {
      const purged = await purgeTodayRevistaSnapshotsNotApprovedOn(sm.id, magazineId);
      const paused = await pauseSupersededSeriesMappings(sm.id, magazineId);
      log.info(
        {
          seriesKey: candidate.seriesKey,
          superseded: superseded.length,
          purgedToday: purged,
          pausedMappings: paused,
        },
        'revista: previous magazines superseded (same series)',
      );
    }

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
    // If we already created the magazine row, flip it to 'failed' so it does
    // not sit forever in 'processing' (which would look like an in-flight run
    // and block --force-less retries of the same hash in some UIs).
    const detail = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'revista: processing failed');
    captureError(err, { supermarket: sm.id, magazine: candidate.label });
    if (magazineId) {
      try {
        await setMagazineStatus(magazineId, 'failed');
        await createAlert({
          severity: 'warning',
          type: 'revista_failed',
          supermarketId: sm.id,
          title: `Falló el escaneo de una revista de ${sm.name}`,
          message: `La revista "${candidate.label}" no pudo procesarse: ${detail}`,
          context: { magazine_id: magazineId, error: detail },
        });
      } catch (markErr) {
        log.warn({ err: markErr, magazineId }, 'revista: could not mark magazine failed');
      }
    }
    return {
      supermarketId: sm.id,
      label: candidate.label,
      status: 'failed',
      hash: candidate.hash,
      ...(magazineId ? { magazineId } : {}),
      error: detail,
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

/**
 * Decide whether a discovered candidate should be processed given skip/only
 * filters. Thin wrapper: the rule itself lives in `decide.ts` so the preview
 * endpoint applies the identical filter.
 */
/**
 * The stored issue's validity period. Falls back to re-deriving it from the
 * label for rows written before migration 023 / the backfill, so the re-upload
 * guard keeps working on an un-backfilled database instead of degrading to
 * "unknown" for every comparison.
 */
function magazinePeriod(row: MagazineRow): FlyerPeriod | null {
  if (row.period_start && row.period_end) {
    // Never assume `exact`: a stored fortnight may have been inferred from
    // "Agosto primera quincena", and the guard treats `exact` as proof.
    return {
      start: row.period_start,
      end: row.period_end,
      confidence: row.period_confidence === 'exact' ? 'exact' : 'inferred',
    };
  }
  return parseFlyerPeriod(row.label, new Date(row.detected_at));
}

function seriesAllowed(seriesKey: string, sm: RevistaSupermarket, opts: ProcessOptions): boolean {
  return shouldProcessSeries(seriesKey, sm.skipSeries ?? [], {
    ...(opts.skipSeries ? { skipSeries: opts.skipSeries } : {}),
    ...(opts.onlySeries ? { onlySeries: opts.onlySeries } : {}),
  });
}

/** Process one supermarket: discover, dedup, and process any new issues. */
export async function processSupermarket(
  sm: RevistaSupermarket,
  opts: ProcessOptions = {},
  catalogIndexPromise?: Promise<Awaited<ReturnType<typeof buildCatalogIndex>>>,
): Promise<MagazineSummary[]> {
  const log = logger.child({ supermarket: sm.id });
  const startedAt = Date.now();

  let candidates: MagazineCandidate[];
  try {
    // Timeout the discovery probe so a stalled site (e.g. Playwright/publuu)
    // can't wedge the sequential daily check for the other chains.
    candidates = await withTimeout(
      discoverCandidates(sm.strategy, opts.pageSelection),
      revistaConfig.discoverTimeoutMs,
      `revista discovery (${sm.id})`,
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'revista: discovery failed');
    captureError(err, { supermarket: sm.id, phase: 'discover' });
    await recordRevistaCheck({
      supermarketId: sm.id,
      strategy: sm.strategy.strategy,
      outcome: 'error',
      candidates: 0,
      newIssues: 0,
      durationMs: Date.now() - startedAt,
      detail,
      scrapeRunId: opts.scrapeRunId ?? null,
    });
    return [{ supermarketId: sm.id, label: '(discovery)', status: 'failed', hash: '', error: detail }];
  }

  // Decide which candidates actually need (expensive) processing.
  const toProcess: MagazineCandidate[] = [];
  const summaries: MagazineSummary[] = [];
  const reuploadsSkipped: string[] = [];
  for (const c of candidates) {
    // Series filter runs BEFORE download/render — saves the whole flyer cost.
    if (!seriesAllowed(c.seriesKey, sm, opts)) {
      log.info(
        { label: c.label, seriesKey: c.seriesKey },
        'revista: skipping series (skipSeries / onlySeries)',
      );
      summaries.push({
        supermarketId: sm.id,
        label: c.label,
        status: 'skipped',
        hash: c.hash,
      });
      continue;
    }

    const existing = await findMagazineByHash(sm.id, c.hash);
    if (!wouldProcess(existing, opts.force)) {
      summaries.push({
        supermarketId: sm.id,
        label: c.label,
        status: 'skipped',
        hash: c.hash,
        magazineId: existing?.id ?? '',
      });
      continue;
    }

    // Re-upload guard: the hash is new, but the chain may have simply
    // re-exported the issue we already scanned. Vital republishes the same PDF
    // several times a day and the hash keys off content-length/ETag, so without
    // this every run would rescan at full vision cost AND supersede whatever the
    // operator had already curated.
    if (!existing && !opts.force) {
      const current = await findCurrentMagazineInSeries(sm.id, c.seriesKey);
      const verdict = classifyReupload({
        strategy: sm.strategy.strategy,
        candidate: {
          label: c.label,
          period: parseFlyerPeriod(c.label, new Date()),
          fileSize: c.fileSize,
        },
        current: current
          ? {
              label: current.label,
              period: magazinePeriod(current),
              fileSize: current.file_size,
            }
          : null,
      });
      if (verdict.reupload) {
        log.info(
          { label: c.label, seriesKey: c.seriesKey, currentId: current?.id, reason: verdict.reason },
          'revista: skipping re-upload of an issue already scanned',
        );
        reuploadsSkipped.push(`${c.label} (${verdict.reason})`);
        summaries.push({
          supermarketId: sm.id,
          label: c.label,
          status: 'skipped',
          hash: c.hash,
          ...(current ? { magazineId: current.id } : {}),
        });
        continue;
      }
    }
    toProcess.push(c);
  }

  // A skipped re-upload must be visible: otherwise "nothing changed" reads the
  // same whether the site published nothing or we declined to rescan it.
  const reuploadNote = reuploadsSkipped.length > 0
    ? ` | re-subidas salteadas: ${reuploadsSkipped.join('; ')}`
    : '';

  if (toProcess.length === 0) {
    log.info({ candidates: candidates.length }, 'revista: nothing changed, skipping');
    await recordRevistaCheck({
      supermarketId: sm.id,
      strategy: sm.strategy.strategy,
      outcome: 'no_change',
      candidates: candidates.length,
      newIssues: 0,
      durationMs: Date.now() - startedAt,
      detail:
        (candidates.length === 0 ? 'no magazine found on site' : 'all issues already known') +
        reuploadNote,
      scrapeRunId: opts.scrapeRunId ?? null,
    });
    return summaries;
  }

  // Build the catalog index once per supermarket (shared across its issues).
  const indexPromise = catalogIndexPromise ?? loadCatalog().then(buildCatalogIndex);
  for (const c of toProcess) {
    summaries.push(await processCandidate(sm, c, opts, indexPromise));
  }

  const processed = summaries.filter((s) => s.status === 'processed').length;
  const failed = summaries.filter((s) => s.status === 'failed').length;
  await recordRevistaCheck({
    supermarketId: sm.id,
    strategy: sm.strategy.strategy,
    outcome: processed > 0 ? 'new_issue' : failed > 0 ? 'error' : 'no_change',
    candidates: candidates.length,
    newIssues: processed,
    durationMs: Date.now() - startedAt,
    detail:
      `processed=${processed} failed=${failed} of ${toProcess.length} new issue(s)` + reuploadNote,
    scrapeRunId: opts.scrapeRunId ?? null,
  });
  return summaries;
}

/**
 * Ingest one PDF URL for a revista chain, bypassing discovery.
 * Used when the offers-page HTML is stale (CDN cache) and a known PDF must be
 * scanned so operators can review it.
 */
export async function ingestPdfUrl(
  supermarketId: string,
  pdfUrl: string,
  opts: ProcessOptions & { label?: string; seriesKey?: string } = {},
): Promise<MagazineSummary> {
  const supers = await loadRevistaSupermarkets();
  const sm = supers.find((s) => s.id === supermarketId);
  if (!sm) {
    throw new Error(
      `No revista supermarket "${supermarketId}" (is config.source_type=revista and is_active=true?)`,
    );
  }

  const candidate = await candidateFromPdfUrl(pdfUrl, {
    pageSelection: opts.pageSelection,
    label: opts.label,
    seriesKey: opts.seriesKey,
  });

  // Dedup unless --force / prior failed|processing. Same predicate the daily
  // check and the preview button use — see decide.ts.
  const existing = await findMagazineByHash(sm.id, candidate.hash);
  if (!wouldProcess(existing, opts.force)) {
    return {
      supermarketId: sm.id,
      label: candidate.label,
      status: 'skipped',
      hash: candidate.hash,
      ...(existing ? { magazineId: existing.id } : {}),
    };
  }

  const indexPromise = loadCatalog().then(buildCatalogIndex);
  return processCandidate(sm, candidate, opts, indexPromise);
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
  // It is only awaited inside processCandidate, i.e. ONLY when something needs
  // processing. On a quiet day nothing awaits it, so a rejection here would be
  // an unhandled rejection — which Node turns into a process exit. Swallow it
  // here; the real await inside processCandidate still surfaces the error and
  // fails that magazine properly.
  indexPromise.catch(() => {});

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
