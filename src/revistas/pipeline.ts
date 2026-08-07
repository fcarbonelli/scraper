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
import { assertOpenAiKey, revistaConfig } from './config.js';
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
import {
  classifyReupload,
  shouldProcessSeries,
  wouldProcess,
  REUPLOAD_SUSPICIOUS_DELTA_PCT,
} from './decide.js';
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

/**
 * A skipped re-upload whose file moved a lot is the one case the guard can get
 * wrong: same URL, same period, but the chain replaced the content (a price
 * correction). We still skip — the alternative is rescanning every re-export —
 * but the operator gets told, with the number, and can force it from the panel.
 * Reuses the existing `revista_review` type: a new AlertType needs a migration
 * for the alerts.type CHECK, and this does not warrant one.
 *
 * Covers `html-pdf-links` ONLY, and not by choice: pubhtml5 discovery has no
 * size at all (config.js gives pages and a title, never bytes), so a Rosental
 * re-export that changed its images has no magnitude to threshold. That gap is
 * real; it just has no cheap signal behind it.
 *
 * Deduped on the candidate hash: the condition holds for as long as the chain
 * keeps that file up, and one alert per day for a week is how a Daily Review
 * stops being read.
 */
async function alertSuspiciousReupload(
  sm: RevistaSupermarket,
  candidate: MagazineCandidate,
  current: MagazineRow | null,
  verdict: ReturnType<typeof classifyReupload>,
  log: Logger,
): Promise<void> {
  const delta = verdict.sizeDeltaPct;
  if (delta === null || delta <= REUPLOAD_SUSPICIOUS_DELTA_PCT) return;
  try {
    const { data: open, error: openErr } = await db
      .from('alerts')
      .select('id')
      .eq('type', 'revista_review')
      .eq('status', 'open')
      .contains('context', { hash: candidate.hash })
      .limit(1);
    if (openErr) throw openErr;
    if ((open ?? []).length > 0) return;

    await createAlert({
      severity: 'info',
      type: 'revista_review',
      supermarketId: sm.id,
      title: `${sm.name} re-subió un folleto con cambios grandes`,
      message:
        `"${candidate.label}" volvió a publicarse en la misma URL y para el mismo período, ` +
        `pero el archivo cambió ${delta.toFixed(1)}%. No se re-escaneó para no pisar lo ya revisado. ` +
        `Si fue una corrección de precios, reprocesalo desde el panel.`,
      context: {
        magazine_id: current?.id ?? null,
        hash: candidate.hash,
        size_delta_pct: Number(delta.toFixed(2)),
        source_url: candidate.sourceUrl,
        series_key: candidate.seriesKey,
      },
    });
  } catch (err) {
    // An alert is never worth failing the run over.
    log.warn({ err, label: candidate.label }, 'revista: could not raise re-upload alert');
  }
}

function seriesAllowed(seriesKey: string, sm: RevistaSupermarket, opts: ProcessOptions): boolean {
  return shouldProcessSeries(seriesKey, sm.skipSeries ?? [], {
    ...(opts.skipSeries ? { skipSeries: opts.skipSeries } : {}),
    ...(opts.onlySeries ? { onlySeries: opts.onlySeries } : {}),
  });
}

/** Why a candidate is (not) worth the download + vision cost. */
interface CandidateVerdict {
  process: boolean;
  /** In Spanish: it reaches the operator through the check log or the panel. */
  reason: string;
  /** Row already holding this exact hash, if any. */
  existing: MagazineRow | null;
  /** Current issue of the same series, if any. */
  current: MagazineRow | null;
  /** Null when the re-upload guard never ran (series skipped / hash known). */
  reupload: ReturnType<typeof classifyReupload> | null;
}

/**
 * The whole "should we spend on this flyer?" decision, in one place.
 *
 * Both callers that act on it — the daily check (`processSupermarket`) and the
 * panel's Traer button (`ingestCandidatesByHash`) — go through here, for the
 * same reason `decide.ts` is a separate module: a second copy of the rule is how
 * the button stops predicting what the run does.
 */
async function evaluateCandidate(
  sm: RevistaSupermarket,
  c: MagazineCandidate,
  opts: ProcessOptions,
): Promise<CandidateVerdict> {
  if (!seriesAllowed(c.seriesKey, sm, opts)) {
    return {
      process: false,
      reason: `la serie "${c.seriesKey}" está filtrada (skipSeries / onlySeries)`,
      existing: null,
      current: null,
      reupload: null,
    };
  }

  const existing = await findMagazineByHash(sm.id, c.hash);
  if (existing) {
    const retry = wouldProcess(existing, opts.force);
    return {
      process: retry,
      reason: retry
        ? `ya está en base en estado "${existing.status}" → se reintenta`
        : `ya está en base (${existing.status})`,
      existing,
      current: null,
      reupload: null,
    };
  }
  if (opts.force) {
    // No lookup: forcing means the guard's inputs don't matter, and nothing
    // downstream reads `current` on the processing path.
    return {
      process: true,
      reason: 'forzado: se procesa sin aplicar la guarda de re-subida',
      existing: null,
      current: null,
      reupload: null,
    };
  }

  // Re-upload guard: the hash is new, but the chain may have simply re-exported
  // the issue we already scanned. Vital republishes the same PDF several times
  // a day and the hash keys off content-length/ETag, so without this every run
  // would rescan at full vision cost AND supersede whatever the operator had
  // already curated.
  const current = await findCurrentMagazineInSeries(sm.id, c.seriesKey);
  const reupload = classifyReupload({
    strategy: sm.strategy.strategy,
    candidate: {
      label: c.label,
      period: parseFlyerPeriod(c.label, new Date()),
      fileSize: c.fileSize,
      sourceUrl: c.sourceUrl,
      pageCount: c.pageCount,
    },
    current: current
      ? {
          label: current.label,
          period: magazinePeriod(current),
          fileSize: current.file_size,
          sourceUrl: current.source_url,
          pageCount: current.page_count,
        }
      : null,
  });
  return { process: !reupload.reupload, reason: reupload.reason, existing: null, current, reupload };
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
  /** Candidates processed even though the series already had a current issue. */
  const rescanned: string[] = [];
  for (const c of candidates) {
    // Runs BEFORE download/render — every skip here saves a whole flyer's cost.
    const verdict = await evaluateCandidate(sm, c, opts);

    if (!verdict.process) {
      const magazineId = verdict.existing?.id ?? verdict.current?.id;
      if (verdict.reupload?.reupload) {
        log.info(
          {
            label: c.label,
            seriesKey: c.seriesKey,
            currentId: verdict.current?.id,
            reason: verdict.reason,
            sizeDeltaPct: verdict.reupload.sizeDeltaPct,
          },
          'revista: skipping re-upload of an issue already scanned',
        );
        reuploadsSkipped.push(`${c.label} (${verdict.reason})`);
        await alertSuspiciousReupload(sm, c, verdict.current, verdict.reupload, log);
      } else if (!verdict.existing) {
        log.info(
          { label: c.label, seriesKey: c.seriesKey, reason: verdict.reason },
          'revista: skipping series (skipSeries / onlySeries)',
        );
      }
      summaries.push({
        supermarketId: sm.id,
        label: c.label,
        status: 'skipped',
        hash: c.hash,
        // The row this skip points at: the one already holding the hash, else
        // the current issue of the series we declined to rescan. A filtered
        // series points at nothing.
        ...(magazineId ? { magazineId } : {}),
      });
      continue;
    }

    // Declined to skip a series that already has a current issue: say so. Until
    // 2026-08-05 only the SKIP was logged, so a guard that let a re-export
    // through ("size moved 1.26% → operator decides") left no trace anywhere
    // and the rescan looked spontaneous.
    if (verdict.current && verdict.reupload) {
      log.info(
        {
          label: c.label,
          seriesKey: c.seriesKey,
          currentId: verdict.current.id,
          reason: verdict.reason,
          sizeDeltaPct: verdict.reupload.sizeDeltaPct,
        },
        'revista: processing despite a current issue in this series',
      );
      rescanned.push(`${c.label} (${verdict.reason})`);
    }
    toProcess.push(c);
  }

  // A skipped re-upload must be visible: otherwise "nothing changed" reads the
  // same whether the site published nothing or we declined to rescan it.
  const reuploadNote = reuploadsSkipped.length > 0
    ? ` | re-subidas salteadas: ${reuploadsSkipped.join('; ')}`
    : '';

  // The symmetric half: a rescan of a series that already had a current issue
  // is the expensive decision, and it must be as legible in the check log as
  // the cheap one. Only reachable on the processing path — a rescan by
  // definition put something in `toProcess`.
  const rescanNote = rescanned.length > 0
    ? ` | re-escaneos con vigente en la serie: ${rescanned.join('; ')}`
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
      `processed=${processed} failed=${failed} of ${toProcess.length} new issue(s)` +
      reuploadNote +
      rescanNote,
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

/** One flyer the panel asked for, and what became of it. */
export interface IngestOutcome {
  hash: string;
  label: string;
  seriesKey: string;
  sourceUrl: string;
  status: 'processed' | 'skipped' | 'failed' | 'not_found';
  /** In Spanish, ready to show in the panel. */
  reason: string;
  magazineId?: string;
  matched?: number;
  pages?: number;
  error?: string;
}

export interface IngestProgress {
  total: number;
  done: number;
  processed: number;
  skipped: number;
  failed: number;
  /** Label of the flyer being read right now — the only slow step. */
  current: string | null;
}

export interface IngestCandidateRef {
  hash: string;
  /**
   * Fallback key. An html-pdf-links hash folds in content-length/ETag and Vital
   * re-uploads the same file several times a day, so the hash the operator saw
   * in the panel can be stale minutes later while the URL still names the flyer.
   */
  sourceUrl?: string;
}

/**
 * Ingest the flyers the panel's check button listed, by hash.
 *
 * The button-facing half of the pipeline (docs/REVISTA_CHECK_BUTTON.md). Three
 * things it must keep doing:
 *
 * 1. **Re-discover, don't trust the caller.** Only what the chain's own site
 *    serves right now is ingestable. Taking a URL from the panel would make
 *    this "download and vision-scan whatever I send you".
 * 2. **Re-run the guards HERE, not at enqueue time.** Two clicks on the same
 *    flyer, or a click landing while the 6am check is mid-run, must end in
 *    "skipped" and not in two magazine rows.
 * 3. **Never touch `revista_check_log`.** That table is the ledger of the
 *    AUTOMATIC probe and the signal used to tell whether the daily run
 *    happened; manual clicks would destroy that diagnostic. This is also why it
 *    can't just call `processSupermarket`, which always records a check.
 */
export async function ingestCandidatesByHash(
  supermarketId: string,
  opts: {
    candidates?: IngestCandidateRef[];
    force?: boolean;
    onProgress?: (p: IngestProgress) => void;
  } = {},
): Promise<IngestOutcome[]> {
  // Loudly, before anything else. `runRevistaCheck` returns silently without a
  // key — the exact failure this family of buttons exists to expose.
  assertOpenAiKey();

  const supers = await loadRevistaSupermarkets();
  const sm = supers.find((s) => s.id === supermarketId);
  if (!sm) {
    throw new Error(
      `No revista supermarket "${supermarketId}" (is config.source_type=revista and is_active=true?)`,
    );
  }
  const log = logger.child({ supermarket: sm.id, phase: 'revista-ingest' });

  const found = await withTimeout(
    discoverCandidates(sm.strategy),
    revistaConfig.discoverTimeoutMs,
    `revista ingest discovery (${sm.id})`,
  );

  const wanted = opts.candidates ?? [];
  const selected: MagazineCandidate[] = [];
  const outcomes: IngestOutcome[] = [];

  if (wanted.length === 0) {
    // No explicit selection: everything the daily check would take.
    selected.push(...found);
  } else {
    for (const ref of wanted) {
      const byHash = found.find((c) => c.hash === ref.hash);
      if (byHash) {
        selected.push(byHash);
        continue;
      }
      const byUrl = ref.sourceUrl
        ? found.find((c) => c.sourceUrl === ref.sourceUrl)
        : undefined;
      if (byUrl) {
        log.info({ hash: ref.hash, url: ref.sourceUrl }, 'revista ingest: hash moved, matched by URL');
        selected.push(byUrl);
        continue;
      }
      outcomes.push({
        hash: ref.hash,
        label: '(desconocido)',
        seriesKey: '',
        sourceUrl: ref.sourceUrl ?? '',
        status: 'not_found',
        reason: 'ya no está en el sitio de la cadena — volvé a chequear',
      });
    }
  }

  const progress: IngestProgress = {
    total: selected.length,
    done: 0,
    processed: 0,
    skipped: 0,
    failed: 0,
    current: null,
  };
  opts.onProgress?.({ ...progress });

  // Built lazily and once: a selection that turns out to be all skips must not
  // pay for the catalog. The rejection is swallowed here and surfaced by the
  // real await inside processCandidate — an unawaited rejection exits Node.
  let indexPromise: Promise<Awaited<ReturnType<typeof buildCatalogIndex>>> | null = null;
  const catalogIndex = (): Promise<Awaited<ReturnType<typeof buildCatalogIndex>>> => {
    if (!indexPromise) {
      indexPromise = loadCatalog().then(buildCatalogIndex);
      indexPromise.catch(() => {});
    }
    return indexPromise;
  };

  const processOpts: ProcessOptions = { scrapeRunId: null, force: opts.force ?? false };

  for (const c of selected) {
    progress.current = c.label;
    opts.onProgress?.({ ...progress });

    const verdict = await evaluateCandidate(sm, c, processOpts);
    const base = { hash: c.hash, label: c.label, seriesKey: c.seriesKey, sourceUrl: c.sourceUrl };

    if (!verdict.process) {
      const magazineId = verdict.existing?.id ?? verdict.current?.id;
      log.info({ label: c.label, reason: verdict.reason }, 'revista ingest: skipped');
      outcomes.push({
        ...base,
        status: 'skipped',
        reason: verdict.reason,
        ...(magazineId ? { magazineId } : {}),
      });
      progress.skipped++;
    } else {
      const summary = await processCandidate(sm, c, processOpts, catalogIndex());
      if (summary.status === 'processed') {
        outcomes.push({
          ...base,
          status: 'processed',
          reason: `traída: ${summary.matched ?? 0} producto(s) con match en ${summary.pages ?? 0} página(s)`,
          ...(summary.magazineId ? { magazineId: summary.magazineId } : {}),
          ...(summary.matched === undefined ? {} : { matched: summary.matched }),
          ...(summary.pages === undefined ? {} : { pages: summary.pages }),
        });
        progress.processed++;
      } else {
        outcomes.push({
          ...base,
          status: 'failed',
          reason: `falló el procesamiento: ${summary.error ?? 'error desconocido'}`,
          ...(summary.magazineId ? { magazineId: summary.magazineId } : {}),
          ...(summary.error ? { error: summary.error } : {}),
        });
        progress.failed++;
      }
    }

    progress.done++;
    progress.current = null;
    opts.onProgress?.({ ...progress });
  }

  log.info({ progress, requested: wanted.length }, 'revista ingest complete');
  return outcomes;
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
