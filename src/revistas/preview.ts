/**
 * "¿Qué folletos faltan?" — discover and classify every chain's current issues
 * WITHOUT writing a row or calling OpenAI.
 *
 * This answers the one question the operator could not ask before: *what would
 * the daily check do if it ran right now?* Discovery is already cheap and
 * AI-free (Makro/Vital are an HTML fetch plus a HEAD per PDF; Rosental is two
 * fetches; Playwright only appears in publuu's DOWNLOAD, never its discovery),
 * so the whole probe costs a few seconds and nothing else.
 *
 * Two properties this module must keep:
 *
 * 1. It never calls `runRevistaCheck`. That function early-returns silently
 *    when `REVISTA_ENABLED=false` or `OPENAI_API_KEY` is missing — the exact
 *    failure this button exists to diagnose. Hanging off it would make the
 *    button answer "nothing new" in precisely the situation where the operator
 *    needs the truth. It lists the flyers regardless and reports the config as
 *    a warning instead.
 * 2. It never writes to `revista_check_log`. That table is the ledger of the
 *    AUTOMATIC probe and the signal used to tell whether the daily run
 *    happened; manual clicks would destroy that diagnostic.
 */

import { logger } from '../shared/logger.js';
import { revistaConfig } from './config.js';
import { loadRevistaSupermarkets, type RevistaSupermarket } from './pipeline.js';
import { discoverCandidates, type MagazineCandidate } from './sources.js';
import { findMagazineByHash, findCurrentMagazineInSeries, type MagazineRow } from './store.js';
import { parseFlyerPeriod, type FlyerPeriod } from './period.js';
import { classifyReupload, shouldProcessSeries, sizeDeltaPct, wouldProcess } from './decide.js';
import { mapPool, withTimeout } from './pool.js';

export type CandidateState =
  /** No row with this hash and no current issue in the series. */
  | 'nuevo'
  /** A current issue exists in this series but covers a different period. */
  | 'nueva_edicion'
  /** Same series, same period, different hash — the file was re-exported. */
  | 're_subida'
  /** Hash already stored and reviewed or awaiting review. Nothing to do. */
  | 'ya_en_base'
  /** Hash stored but stuck in processing/failed — the pipeline would retry it. */
  | 'reprocesable'
  /** Filtered out by config.revista.skipSeries. */
  | 'serie_ignorada';

export interface PreviewCandidate {
  label: string;
  seriesKey: string;
  sourceUrl: string;
  hash: string;
  state: CandidateState;
  /** Would the daily check spend vision tokens on this one right now? */
  ingestable: boolean;
  periodStart: string | null;
  periodEnd: string | null;
  periodConfidence: 'exact' | 'inferred' | null;
  /** Days since the period ended. Negative = still valid. Null = unknown. */
  expiredDaysAgo: number | null;
  fileSize: number | null;
  lastModified: string | null;
  pageCount: number | null;
  /** Size difference against the current stored issue of the same series, in %. */
  sizeDeltaPct: number | null;
  /** Why the candidate landed in this state, in plain words. */
  reason: string;
  existing: { id: string; status: string; detectedAt: string } | null;
  currentInSeries: { id: string; label: string; detectedAt: string } | null;
}

export interface PreviewChain {
  supermarketId: string;
  supermarketName: string;
  strategy: string;
  checkedAt: string;
  durationMs: number;
  candidates: PreviewCandidate[];
  error: string | null;
}

export interface RevistaPreview {
  config: {
    revistaEnabled: boolean;
    openaiKeyPresent: boolean;
    chainsConfigured: number;
  };
  warnings: string[];
  chains: PreviewChain[];
}

function daysSince(endIso: string | null): number | null {
  if (!endIso) return null;
  const end = Date.parse(`${endIso}T23:59:59Z`);
  if (Number.isNaN(end)) return null;
  return Math.floor((Date.now() - end) / 86_400_000);
}

function rowPeriod(row: MagazineRow | null): FlyerPeriod | null {
  if (!row) return null;
  if (row.period_start && row.period_end) {
    // See magazinePeriod() in pipeline.ts: a stored period is only `exact` if it
    // was recorded as such. Defaulting to `exact` would let an inferred
    // fortnight authorise skipping a magazine.
    return {
      start: row.period_start,
      end: row.period_end,
      confidence: row.period_confidence === 'exact' ? 'exact' : 'inferred',
    };
  }
  // Row predates migration 023 / the backfill — derive it from the label so the
  // comparison still works instead of silently degrading to "unknown".
  return parseFlyerPeriod(row.label, new Date(row.detected_at));
}

async function classify(
  sm: RevistaSupermarket,
  candidate: MagazineCandidate,
): Promise<PreviewCandidate> {
  const period = parseFlyerPeriod(candidate.label, new Date());
  const base = {
    label: candidate.label,
    seriesKey: candidate.seriesKey,
    sourceUrl: candidate.sourceUrl,
    hash: candidate.hash,
    periodStart: period?.start ?? null,
    periodEnd: period?.end ?? null,
    periodConfidence: period?.confidence ?? null,
    expiredDaysAgo: daysSince(period?.end ?? null),
    fileSize: candidate.fileSize ?? null,
    lastModified: candidate.lastModified ?? null,
    pageCount: candidate.pageCount ?? null,
  };

  if (!shouldProcessSeries(candidate.seriesKey, sm.skipSeries)) {
    return {
      ...base,
      state: 'serie_ignorada',
      ingestable: false,
      sizeDeltaPct: null,
      reason: `la serie "${candidate.seriesKey}" está en skipSeries`,
      existing: null,
      currentInSeries: null,
    };
  }

  const existing = await findMagazineByHash(sm.id, candidate.hash);
  const current = await findCurrentMagazineInSeries(sm.id, candidate.seriesKey);
  const existingRef = existing
    ? { id: existing.id, status: existing.status, detectedAt: existing.detected_at }
    : null;
  const currentRef = current
    ? { id: current.id, label: current.label, detectedAt: current.detected_at }
    : null;
  const delta = sizeDeltaPct(candidate.fileSize, current?.file_size);

  if (existing) {
    const retriable = wouldProcess(existing, false);
    return {
      ...base,
      state: retriable ? 'reprocesable' : 'ya_en_base',
      ingestable: retriable,
      sizeDeltaPct: delta,
      reason: retriable
        ? `ya está en base pero quedó en "${existing.status}" — el chequeo lo reintentaría`
        : `ya está en base (${existing.status})`,
      existing: existingRef,
      currentInSeries: currentRef,
    };
  }

  const verdict = classifyReupload({
    strategy: sm.strategy.strategy,
    candidate: {
      label: candidate.label,
      period,
      fileSize: candidate.fileSize,
      sourceUrl: candidate.sourceUrl,
      pageCount: candidate.pageCount,
    },
    current: current
      ? {
          label: current.label,
          period: rowPeriod(current),
          fileSize: current.file_size,
          sourceUrl: current.source_url,
          pageCount: current.page_count,
        }
      : null,
  });

  if (verdict.reupload) {
    return {
      ...base,
      state: 're_subida',
      ingestable: false,
      sizeDeltaPct: verdict.sizeDeltaPct,
      reason: verdict.reason,
      existing: null,
      currentInSeries: currentRef,
    };
  }

  return {
    ...base,
    state: current ? 'nueva_edicion' : 'nuevo',
    ingestable: true,
    sizeDeltaPct: verdict.sizeDeltaPct,
    reason: verdict.reason,
    existing: null,
    currentInSeries: currentRef,
  };
}

async function previewChain(sm: RevistaSupermarket): Promise<PreviewChain> {
  const startedAt = Date.now();
  const head = {
    supermarketId: sm.id,
    supermarketName: sm.name,
    strategy: sm.strategy.strategy,
    checkedAt: new Date().toISOString(),
  };
  try {
    const candidates = await withTimeout(
      discoverCandidates(sm.strategy),
      revistaConfig.discoverTimeoutMs,
      `revista preview (${sm.id})`,
    );
    const classified: PreviewCandidate[] = [];
    for (const c of candidates) classified.push(await classify(sm, c));
    return { ...head, durationMs: Date.now() - startedAt, candidates: classified, error: null };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn({ err, supermarket: sm.id }, 'revista preview: discovery failed');
    return { ...head, durationMs: Date.now() - startedAt, candidates: [], error: detail };
  }
}

/**
 * Probe every configured revista chain (or the given subset) and report what
 * the daily check would do. Read-only; safe to call as often as you like.
 */
export async function previewRevistaChains(supermarketIds?: string[]): Promise<RevistaPreview> {
  const all = await loadRevistaSupermarkets();
  const wanted = supermarketIds?.length
    ? all.filter((s) => supermarketIds.includes(s.id))
    : all;

  const warnings: string[] = [];
  if (!revistaConfig.enabled) {
    warnings.push(
      'El chequeo automático está deshabilitado (REVISTA_ENABLED=false): estos folletos no se van a traer solos.',
    );
  }
  if (!revistaConfig.openaiApiKey) {
    warnings.push(
      'Falta OPENAI_API_KEY: el chequeo automático sale sin procesar nada y sin dejar rastro.',
    );
  }
  if (all.length === 0) {
    warnings.push(
      'No hay ninguna cadena con config.source_type="revista" activa: el chequeo automático no tiene qué mirar.',
    );
  }
  if (supermarketIds?.length) {
    const missing = supermarketIds.filter((id) => !all.some((s) => s.id === id));
    for (const id of missing) {
      warnings.push(`"${id}" no es una cadena de revista activa; se omitió.`);
    }
  }

  const chains = await mapPool(wanted, 3, (sm) => previewChain(sm));

  return {
    config: {
      revistaEnabled: revistaConfig.enabled,
      openaiKeyPresent: Boolean(revistaConfig.openaiApiKey),
      chainsConfigured: all.length,
    },
    warnings,
    chains,
  };
}
