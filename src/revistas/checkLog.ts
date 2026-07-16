/**
 * Revista check log — a per-site record of every "did the magazine change?"
 * probe, so the operator can see the daily check ran even when (as usual)
 * nothing new was found. Backed by `revista_check_log` (migration 009).
 *
 * Writing a log row is best-effort: a logging failure must never break the
 * pipeline, so `recordRevistaCheck` swallows its own errors.
 */

import { db } from '../shared/db.js';
import { logger } from '../shared/logger.js';

export type RevistaCheckOutcome = 'no_change' | 'new_issue' | 'error';

export interface RevistaCheckEntry {
  supermarketId: string;
  strategy: string | null;
  outcome: RevistaCheckOutcome;
  /** Issues discovered on the site (0 = nothing found there). */
  candidates: number;
  /** Newly processed issues this check. */
  newIssues: number;
  durationMs: number;
  detail?: string | null;
  scrapeRunId?: string | null;
}

/** Append one check-log row. Never throws (logging must not break the run). */
export async function recordRevistaCheck(entry: RevistaCheckEntry): Promise<void> {
  try {
    const { error } = await db.from('revista_check_log').insert({
      supermarket_id: entry.supermarketId,
      strategy: entry.strategy,
      outcome: entry.outcome,
      candidates: entry.candidates,
      new_issues: entry.newIssues,
      duration_ms: entry.durationMs,
      detail: entry.detail ?? null,
      scrape_run_id: entry.scrapeRunId ?? null,
    });
    if (error) throw error;
  } catch (err) {
    logger.warn({ err, supermarket: entry.supermarketId }, 'revista: failed to write check-log row');
  }
}
