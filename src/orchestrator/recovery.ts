/**
 * Automatic recovery runs.
 *
 * Whole-site scrape failures are usually transient: a site briefly blocks the
 * datacenter IP, a CDN hiccups, or requests time out under load. These clear on
 * their own within minutes. Instead of paging a human to press "Retry failed"
 * (and instead of firing a CRITICAL alert for something that fixes itself), the
 * finalizer asks this module to schedule ONE delayed recovery run for the
 * affected supermarket. The recovery run re-scrapes only that site's failed
 * products after a short delay; if it succeeds, the incident never surfaces.
 *
 * If the recovery run STILL fails, it finalizes like any other run and DOES
 * alert (see aggregate.ts) — so persistent breakage is never hidden, it's just
 * delayed by one retry cycle.
 *
 * Guardrails:
 *   - Only transient error classes qualify. A broken selector or a delisted
 *     product won't fix itself on retry, so those alert immediately.
 *   - Recovery runs are flagged `metadata.recovery = true`, and we never
 *     schedule a recovery for a recovery run — so one incident yields at most
 *     one automatic retry.
 */

import { db } from '../shared/db.js';
import { logger } from '../shared/logger.js';
import { loadRunDiagnostics } from '../shared/runDiagnostics.js';
import { defaultJobOptions, getQueue, type ScrapeJobData } from '../shared/queue.js';
import type { ErrorType } from '../shared/errors.js';

/**
 * Delay before a recovery run's jobs execute. Long enough for a transient IP
 * block / CDN blip / load spike to clear, short enough that the recovered
 * prices still land in today's run window.
 */
export const RECOVERY_DELAY_MS = 20 * 60 * 1000; // 20 min

/** Minimum failed products before an automatic recovery is worthwhile. */
const RECOVERY_MIN_FAILURES = 5;

/** Share of failures that must be the dominant transient class to recover. */
const RECOVERY_DOMINANT_FRACTION = 0.5;

/**
 * Error classes that are plausibly transient (worth an automatic retry).
 * Everything else (selector_failed, price_missing, product_not_found,
 * region_unavailable, auth_required, parse_failed) reflects a real content /
 * config problem that a blind retry won't fix.
 */
const TRANSIENT_ERROR_TYPES: ReadonlySet<ErrorType | 'unknown'> = new Set<
  ErrorType | 'unknown'
>(['network_error', 'network_timeout', 'rate_limited', 'site_server_error', 'unknown']);

/** Whether an error class is transient enough to be worth an automatic retry. */
export function isTransientErrorType(type: ErrorType | 'unknown' | null | undefined): boolean {
  return type != null && TRANSIENT_ERROR_TYPES.has(type);
}

export interface RecoveryDecisionInput {
  /** Number of failed products for this supermarket in the run. */
  failed: number;
  /** Dominant (most common) final error type among failures, if any. */
  dominantType: ErrorType | 'unknown' | null;
  /** Fraction (0..1) of failures that share the dominant type. */
  dominantFraction: number;
  /** Whether the run being finalized is itself a recovery run. */
  isRecoveryRun: boolean;
}

/**
 * Decide whether a supermarket's failures in a finalized run warrant an
 * automatic delayed retry. Returns true only for a transient-dominated,
 * non-trivial, first-time (non-recovery) failure.
 */
export function shouldAutoRecover(input: RecoveryDecisionInput): boolean {
  if (input.isRecoveryRun) return false; // one automatic retry per incident
  if (input.failed < RECOVERY_MIN_FAILURES) return false;
  // The bulk of the failures must share a transient error class.
  return (
    isTransientErrorType(input.dominantType) &&
    input.dominantFraction >= RECOVERY_DOMINANT_FRACTION
  );
}

interface MappingRow {
  id: string;
  supermarket_id: string;
  external_id: string;
  external_url: string | null;
}

/**
 * Create a delayed recovery run that re-scrapes just `supermarketId`'s failed
 * products from `sourceRunId`. Returns the new run id, or null if there was
 * nothing to enqueue.
 */
export async function scheduleSupermarketRecovery(
  sourceRunId: string,
  supermarketId: string,
  delayMs: number = RECOVERY_DELAY_MS,
): Promise<string | null> {
  const diagnostics = await loadRunDiagnostics(sourceRunId);
  if (!diagnostics) return null;

  // Failed products across the whole source run; we filter to this supermarket
  // via the mapping query below (the mapping carries supermarket_id).
  const failedIds = diagnostics.finalOutcomes
    .filter((o) => o.status === 'failed')
    .map((o) => o.supermarket_product_id);
  if (failedIds.length === 0) return null;

  const { data: mappingData, error: mappingErr } = await db
    .from('supermarket_products')
    .select('id, supermarket_id, external_id, external_url')
    .in('id', failedIds)
    .eq('supermarket_id', supermarketId);
  if (mappingErr) throw mappingErr;
  const mappings = (mappingData ?? []) as MappingRow[];
  if (mappings.length === 0) return null;

  // Create the recovery scrape_run, flagged so the finalizer never recurses
  // into scheduling a recovery-of-a-recovery.
  const { data: runData, error: runErr } = await db
    .from('scrape_runs')
    .insert({
      started_at: new Date().toISOString(),
      status: 'running',
      total_jobs: mappings.length,
      metadata: {
        recovery: true,
        source: 'auto',
        source_run_id: sourceRunId,
        by_supermarket: { [supermarketId]: mappings.length },
      },
    })
    .select('id')
    .single();
  if (runErr) throw runErr;
  const recoveryRunId = runData.id as string;

  // Enqueue the failed products with a delay so the transient condition has
  // time to clear. Delayed jobs emit no job_execution row until they run, so
  // the finalizer correctly sees the run as still pending in the meantime.
  const jobs = mappings.map((m) => ({
    name: 'scrape' as const,
    data: {
      supermarketProductId: m.id,
      supermarketId: m.supermarket_id,
      externalId: m.external_id,
      externalUrl: m.external_url,
      scrapeRunId: recoveryRunId,
      attempt: 1,
    } satisfies ScrapeJobData,
    opts: { ...defaultJobOptions(), delay: delayMs },
  }));

  await getQueue(supermarketId).addBulk(jobs);

  logger.info(
    { recoveryRunId, sourceRunId, supermarketId, count: jobs.length, delayMs },
    'scheduled automatic recovery run',
  );
  return recoveryRunId;
}
