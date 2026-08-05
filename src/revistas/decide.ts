/**
 * The decisions the revista pipeline makes BEFORE spending anything: should
 * this candidate be processed, and is it a genuinely new edition or the same
 * flyer re-exported?
 *
 * Pure on purpose — no DB, no network, no OpenAI. It lives in its own module so
 * `pipeline.ts` (which acts on the decision) and `preview.ts` (which shows the
 * operator what the pipeline WOULD do) call the exact same predicate. If the
 * button and the pipeline ever disagree, the button is worthless — it exists to
 * predict the run, and a second copy of the rule is how that quietly rots.
 */

import { samePeriod, type FlyerPeriod } from './period.js';

/** Just enough of a stored magazine row to decide. */
export interface ExistingMagazine {
  status: 'processing' | 'in_review' | 'reviewed' | 'failed';
}

/**
 * Would the pipeline process this candidate, given whatever row already carries
 * its hash?
 *
 * `processing` and `failed` are retried WITHOUT `--force` on purpose: the first
 * means a run was killed mid-flight (production has rows stuck there for a
 * month), the second a transient render/vision glitch. Both should self-heal on
 * the next check.
 */
export function wouldProcess(existing: ExistingMagazine | null, force = false): boolean {
  if (!existing) return true;
  if (force) return true;
  return existing.status === 'processing' || existing.status === 'failed';
}

/** Series filter: `onlySeries` is a whitelist and beats every skip list. */
export function shouldProcessSeries(
  seriesKey: string,
  configSkip: readonly string[] = [],
  opts: { skipSeries?: readonly string[]; onlySeries?: readonly string[] } = {},
): boolean {
  if (opts.onlySeries && opts.onlySeries.length > 0) return opts.onlySeries.includes(seriesKey);
  const skip = new Set([...configSkip, ...(opts.skipSeries ?? [])]);
  return !skip.has(seriesKey);
}

/**
 * Anything above this is a different file, not a re-export. Vital's re-exports
 * measured on 2026-07-30 all moved under 0.15% (see docs/REVISTAS_PLAN.md
 * §3.1-bis); a threshold much above the observed spread would be invented.
 */
export const REUPLOAD_SIZE_TOLERANCE_PCT = 0.5;

/**
 * A re-export this much bigger or smaller than the stored issue is still
 * skipped (same slot, same period), but the operator is told: at this distance
 * a price correction becomes plausible, and the only way to act on it is to
 * know it happened. Vital's real re-exports of 2026-08-05 moved 1.26% and
 * 3.37%, so the threshold sits above the churn we measured.
 */
export const REUPLOAD_SUSPICIOUS_DELTA_PCT = 5;

/** One side of the comparison: the candidate, or the issue already stored. */
export interface ReuploadSide {
  label: string;
  period: FlyerPeriod | null;
  fileSize?: number | null;
  /** The PDF / flipbook URL. Identical URL + identical period = the same slot. */
  sourceUrl?: string | null;
  /** Known before any download only for pubhtml5 (config.js lists the pages). */
  pageCount?: number | null;
}

export interface ReuploadInput {
  strategy: string;
  candidate: ReuploadSide;
  current: ReuploadSide | null;
}

export interface ReuploadVerdict {
  reupload: boolean;
  /** Size difference vs the stored issue, in percent. Null when unknown. */
  sizeDeltaPct: number | null;
  /**
   * Why, in Spanish — this string is not a log line. It reaches the operator
   * twice: as the `reason` of `POST /v1/revistas/check` (the panel's button,
   * see docs/REVISTA_CHECK_BUTTON.md) and inside the `detail` of
   * `revista_check_log`. Both are read by whoever decides if a flyer is
   * missing, so English here was just a translation asked of the reader.
   */
  reason: string;
}

export function sizeDeltaPct(a?: number | null, b?: number | null): number | null {
  if (!a || !b) return null;
  return Math.abs(a - b) / Math.max(a, b) * 100;
}

/** Percentage as the operator writes it: two decimals, comma. */
function pct(n: number): string {
  return `${n.toFixed(2).replace('.', ',')}%`;
}

/**
 * PubHTML5 falls back to a constant when the book carries no title, and
 * production still stores one Rosental issue as "PubHTML5 flipbook". Matching
 * on one of those would skip a REAL new quincena — 144 pages of the
 * highest-yield source we have — so they disqualify the comparison entirely.
 */
const GENERIC_PUBHTML5_LABELS = new Set(['', 'revista', 'pubhtml5 flipbook']);

function isGenericLabel(label: string): boolean {
  return GENERIC_PUBHTML5_LABELS.has(label.trim().toLowerCase());
}

/** Both sides read their period off explicit day/month pairs, covering the same days. */
function sameExactPeriod(a: ReuploadSide, b: ReuploadSide): boolean {
  return (
    a.period?.confidence === 'exact' &&
    b.period?.confidence === 'exact' &&
    samePeriod(a.period, b.period)
  );
}

function sameUrl(a: ReuploadSide, b: ReuploadSide): boolean {
  const x = a.sourceUrl?.trim();
  const y = b.sourceUrl?.trim();
  return Boolean(x && y && x === y);
}

/**
 * Rosental (`pubhtml5`) has no size to compare at discovery time, but config.js
 * hands us the page list for free — and the title, which is the period in
 * words. Same non-generic title + same page count is the flipbook equivalent of
 * "same slot, same period".
 *
 * This exists because the fingerprint that guards Rosental used to include the
 * ETag / Last-Modified of config.js: on 2026-08-05 those moved while the book
 * was byte-identical (the same 80,401,900 bytes over the same 144 pages), and
 * the pipeline rescanned all 144 pages and superseded a reviewed issue holding
 * 118 approved items. `sources.ts` no longer hashes those headers; this is the
 * second line of defence, for the day PubHTML5 re-exports the images too.
 */
function classifyPubhtml5(
  candidate: ReuploadSide,
  current: ReuploadSide,
  delta: number | null,
): ReuploadVerdict {
  if (isGenericLabel(candidate.label) || isGenericLabel(current.label)) {
    return {
      reupload: false,
      sizeDeltaPct: delta,
      reason: 'el título de pubhtml5 es genérico → no alcanza para distinguir ediciones, se procesa',
    };
  }
  if (candidate.label !== current.label) {
    return { reupload: false, sizeDeltaPct: delta, reason: 'el título es distinto → edición nueva' };
  }
  const pages = candidate.pageCount;
  const storedPages = current.pageCount;
  if (!pages || !storedPages) {
    return {
      reupload: false,
      sizeDeltaPct: delta,
      reason: 'sin cantidad de páginas para comparar — lo decide el operador',
    };
  }
  if (pages !== storedPages) {
    return {
      reupload: false,
      sizeDeltaPct: delta,
      reason: `mismo título pero ${pages} páginas contra ${storedPages} guardadas → edición nueva`,
    };
  }
  return {
    reupload: true,
    sizeDeltaPct: delta,
    reason: `mismo título y las mismas ${pages} páginas → re-exportación`,
  };
}

/**
 * Is this candidate the same issue the chain already published, re-exported?
 *
 * One rule per chain shape, because each gives us a different cheap signal:
 *
 * - `html-pdf-links` (Makro, Vital): the period first, then IDENTITY OF THE
 *   URL. Vital republishes the same PDF over the same URL several times a day,
 *   while every edition it actually publishes gets a fresh file id
 *   (113476.pdf vs 112964.pdf) — so same exact period + same URL is the stored
 *   file re-exported. The size is still reported but no longer decides: the
 *   re-exports measured on 2026-08-05 moved 1.26% and 3.37%, past any tolerance
 *   that could still separate them from a new edition. The URL rule demands an
 *   `exact` period on BOTH sides on purpose — a chain publishing forever at
 *   `/folleto-actual.pdf` under a dateless label must never freeze; there the
 *   size tolerance still rules.
 * - `pubhtml5` (Rosental): title + page count — see {@link classifyPubhtml5}.
 * - `publuu` hashes only the embed URL, so it has no signal at all: never skips.
 *
 * The honest limit: nothing here separates a cosmetic re-export from a PRICE
 * CORRECTION republished over the same URL within the same period. That is why
 * this only ever SKIPS (never processes something it shouldn't), every skip is
 * logged with its delta, a delta past {@link REUPLOAD_SUSPICIOUS_DELTA_PCT}
 * raises an alert for the operator, and `--force` always overrides.
 */
export function classifyReupload(input: ReuploadInput): ReuploadVerdict {
  const delta = sizeDeltaPct(input.candidate.fileSize, input.current?.fileSize);

  if (!input.current) {
    return { reupload: false, sizeDeltaPct: delta, reason: 'no hay edición vigente de esta serie' };
  }
  const { candidate, current } = input;

  if (input.strategy === 'pubhtml5') return classifyPubhtml5(candidate, current, delta);
  if (input.strategy !== 'html-pdf-links') {
    return { reupload: false, sizeDeltaPct: delta, reason: 'la estrategia no es html-pdf-links' };
  }

  const periodsMatch = sameExactPeriod(candidate, current);

  if (candidate.period?.confidence === 'exact' && current.period?.confidence === 'exact') {
    if (!periodsMatch) {
      return { reupload: false, sizeDeltaPct: delta, reason: 'el período es distinto → edición nueva' };
    }
  } else if (candidate.label !== current.label) {
    // No trustworthy period on one side; fall back to the label, which embeds
    // the period for every chain that publishes one.
    return { reupload: false, sizeDeltaPct: delta, reason: 'el título es distinto → edición nueva' };
  }

  if (periodsMatch && sameUrl(candidate, current)) {
    const moved = delta === null ? 'tamaño desconocido' : `cambió ${pct(delta)} de tamaño`;
    return {
      reupload: true,
      sizeDeltaPct: delta,
      reason: `mismo período y misma URL (${moved}) → re-exportación del folleto guardado`,
    };
  }

  if (delta === null) {
    return {
      reupload: false,
      sizeDeltaPct: null,
      reason: 'sin tamaño para comparar — lo decide el operador',
    };
  }
  if (delta > REUPLOAD_SIZE_TOLERANCE_PCT) {
    return {
      reupload: false,
      sizeDeltaPct: delta,
      reason: `mismo período pero el tamaño cambió ${pct(delta)} → lo decide el operador`,
    };
  }

  return {
    reupload: true,
    sizeDeltaPct: delta,
    reason: `mismo período y tamaño dentro del ${pct(REUPLOAD_SIZE_TOLERANCE_PCT)} (${pct(delta)}) → re-exportación`,
  };
}
