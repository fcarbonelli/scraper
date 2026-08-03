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

export interface ReuploadInput {
  strategy: string;
  candidate: { label: string; period: FlyerPeriod | null; fileSize?: number | null };
  current: { label: string; period: FlyerPeriod | null; fileSize?: number | null } | null;
}

export interface ReuploadVerdict {
  reupload: boolean;
  /** Size difference vs the stored issue, in percent. Null when unknown. */
  sizeDeltaPct: number | null;
  reason: string;
}

export function sizeDeltaPct(a?: number | null, b?: number | null): number | null {
  if (!a || !b) return null;
  return Math.abs(a - b) / Math.max(a, b) * 100;
}

/**
 * Is this candidate the same issue the chain already published, re-exported?
 *
 * Scoped to `html-pdf-links` deliberately. The other strategies are immune or
 * would be actively harmed:
 *
 * - `pubhtml5` (Rosental) already hashes the page-image list out of config.js,
 *   so a byte-level re-upload cannot even reach here. Worse, its label is that
 *   file's `title`, whose fallback is the literal string 'Revista' — production
 *   still stores one issue as "PubHTML5 flipbook". Matching on that label would
 *   skip a REAL new quincena, which is 144 pages of the highest-yield source we
 *   have. A false negative here is the most expensive mistake available.
 * - `publuu` hashes only the embed URL, so it has no size signal at all.
 *
 * The honest limit: neither the period nor the size separates a cosmetic
 * re-export from a PRICE CORRECTION — same period, same tiny delta. That is why
 * this only ever SKIPS (never processes something it shouldn't), every skip is
 * logged, and `--force` always overrides. The real mitigation is the operator
 * seeing it flagged with the delta, not the threshold.
 */
export function classifyReupload(input: ReuploadInput): ReuploadVerdict {
  const delta = sizeDeltaPct(input.candidate.fileSize, input.current?.fileSize);

  if (input.strategy !== 'html-pdf-links') {
    return { reupload: false, sizeDeltaPct: delta, reason: 'strategy is not html-pdf-links' };
  }
  if (!input.current) {
    return { reupload: false, sizeDeltaPct: delta, reason: 'no current issue in this series' };
  }

  const { candidate, current } = input;
  const bothPeriodsKnown = Boolean(candidate.period && current.period);

  if (bothPeriodsKnown && candidate.period?.confidence === 'exact' && current.period?.confidence === 'exact') {
    if (!samePeriod(candidate.period, current.period)) {
      return { reupload: false, sizeDeltaPct: delta, reason: 'period differs → new edition' };
    }
  } else if (candidate.label !== current.label) {
    // No trustworthy period on one side; fall back to the label, which embeds
    // the period for every chain that publishes one.
    return { reupload: false, sizeDeltaPct: delta, reason: 'label differs → new edition' };
  }

  if (delta === null) {
    return { reupload: false, sizeDeltaPct: null, reason: 'no size to compare — leave it to the operator' };
  }
  if (delta > REUPLOAD_SIZE_TOLERANCE_PCT) {
    return {
      reupload: false,
      sizeDeltaPct: delta,
      reason: `same period but size moved ${delta.toFixed(2)}% → operator decides`,
    };
  }

  return {
    reupload: true,
    sizeDeltaPct: delta,
    reason: `same period and size within ${REUPLOAD_SIZE_TOLERANCE_PCT}% (${delta.toFixed(2)}%) → re-export`,
  };
}
