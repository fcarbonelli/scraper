/**
 * Per-supermarket alert aggregation.
 *
 * Runs after a scrape_run finalizes. Decides what alerts (if any) to create
 * based on success/failure rates, so you get ONE critical alert when SuperZ
 * has 97/100 products failing — not 97 individual alerts.
 *
 * Thresholds (tunable):
 *   - failure rate >= 80%   -> CRITICAL "supermarket_degraded" (or "selector_broken")
 *   - failure rate >= 30%   -> WARNING  "supermarket_unstable"
 *   - below 30%             -> no aggregated alert; individual issues
 *                              remain visible in job_executions
 */

import { db } from '../shared/db.js';
import { logger } from '../shared/logger.js';
import { createAlert } from './createAlert.js';
import type { ErrorType } from '../shared/errors.js';

const CRITICAL_THRESHOLD = 0.8;
const WARNING_THRESHOLD = 0.3;
const EARLY_ALERT_MIN_FAILURES = 10;

interface SupermarketStat {
  supermarketId: string;
  supermarketName: string;
  total: number;            // distinct supermarket_products in the run
  succeeded: number;
  failed: number;
  /** Final-attempt error_type counts (only for failed products). */
  errorTypeCounts: Map<ErrorType | 'unknown', number>;
}

/**
 * Final outcome per (supermarket_product, run): the LATEST attempt's row.
 * Returned as already-grouped supermarket stats.
 */
async function computeStats(scrapeRunId: string): Promise<SupermarketStat[]> {
  // Pull every job_execution for the run, plus the joined supermarket info.
  // For ~3000 jobs this is small enough to aggregate in JS — and it lets us
  // keep the SQL portable (no custom rpc functions required in Supabase).
  const { data, error } = await db
    .from('job_executions')
    .select(
      `
      supermarket_product_id,
      attempt,
      status,
      error_type,
      supermarket_products:supermarket_product_id (
        supermarket_id,
        supermarkets:supermarket_id (
          id,
          name
        )
      )
    `,
    )
    .eq('scrape_run_id', scrapeRunId);

  if (error) throw error;

  // Step 1: pick the LATEST attempt per supermarket_product.
  // job_executions can have N rows per product (one per retry). The final
  // outcome is the row with the highest `attempt`.
  type Row = (typeof data)[number];
  const finalByProduct = new Map<string, Row>();
  for (const row of data ?? []) {
    const existing = finalByProduct.get(row.supermarket_product_id);
    if (!existing || row.attempt > existing.attempt) {
      finalByProduct.set(row.supermarket_product_id, row);
    }
  }

  // Step 2: group by supermarket.
  const bySupermarket = new Map<string, SupermarketStat>();
  for (const row of finalByProduct.values()) {
    // Joins might come back as object or single-element array
    const sp = Array.isArray(row.supermarket_products)
      ? row.supermarket_products[0]
      : row.supermarket_products;
    if (!sp) continue;
    const sm = Array.isArray(sp.supermarkets) ? sp.supermarkets[0] : sp.supermarkets;
    if (!sm) continue;

    let stat = bySupermarket.get(sm.id);
    if (!stat) {
      stat = {
        supermarketId: sm.id,
        supermarketName: sm.name,
        total: 0,
        succeeded: 0,
        failed: 0,
        errorTypeCounts: new Map(),
      };
      bySupermarket.set(sm.id, stat);
    }
    if (row.status === 'success') {
      stat.total += 1;
      stat.succeeded += 1;
    } else if (row.status === 'failed') {
      stat.total += 1;
      stat.failed += 1;
      const key = (row.error_type ?? 'unknown') as ErrorType | 'unknown';
      stat.errorTypeCounts.set(key, (stat.errorTypeCounts.get(key) ?? 0) + 1);
    }
  }

  return Array.from(bySupermarket.values());
}

interface DominantError {
  type: ErrorType | 'unknown';
  count: number;
  fraction: number;          // 0..1, fraction of failures
}

function dominantError(stat: SupermarketStat): DominantError | null {
  if (stat.errorTypeCounts.size === 0) return null;
  let top: DominantError | null = null;
  for (const [type, count] of stat.errorTypeCounts) {
    if (!top || count > top.count) {
      top = { type, count, fraction: count / stat.failed };
    }
  }
  return top;
}

/** Build a one-line "top errors" summary for the alert message. */
function topErrorsSummary(stat: SupermarketStat, take = 3): string {
  const sorted = Array.from(stat.errorTypeCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, take);
  return sorted.map(([type, count]) => `${type} (${count})`).join(', ');
}

/**
 * Main entry point. Run after a scrape_run finalizes to create whatever
 * supermarket-level alerts are warranted. Idempotency note: this can run
 * twice for the same run — it will create duplicate alerts. Callers should
 * only invoke this once per finalize cycle.
 */
export async function generateAlertsForRun(scrapeRunId: string): Promise<{
  alertsCreated: number;
}> {
  const stats = await computeStats(scrapeRunId);
  let alertsCreated = 0;

  for (const stat of stats) {
    if (stat.total === 0) continue;
    const failureRate = stat.failed / stat.total;
    const log = logger.child({
      supermarket: stat.supermarketId,
      runId: scrapeRunId,
      failureRate,
      total: stat.total,
    });

    if (failureRate >= CRITICAL_THRESHOLD) {
      // Pick a more specific alert type if one error class dominates.
      const dom = dominantError(stat);
      const alertType =
        dom && dom.fraction > 0.7 && dom.type === 'selector_failed'
          ? 'selector_broken'
          : dom && dom.fraction > 0.7 && dom.type === 'rate_limited'
            ? 'rate_limited'
            : dom && dom.fraction > 0.7 && dom.type === 'auth_required'
              ? 'auth_required'
              : 'supermarket_degraded';

      const errorsLine = topErrorsSummary(stat);
      await createAlert({
        severity: 'critical',
        type: alertType,
        supermarketId: stat.supermarketId,
        title: `${stat.supermarketName} degraded`,
        message: `${stat.failed}/${stat.total} products failing. Top errors: ${errorsLine}`,
        context: {
          run_id: scrapeRunId,
          failure_rate: `${Math.round(failureRate * 100)}%`,
          total: stat.total,
          succeeded: stat.succeeded,
          failed: stat.failed,
          top_errors: errorsLine,
        },
      });
      alertsCreated += 1;
      log.warn({ alertType }, 'created CRITICAL aggregate alert');
    } else if (failureRate >= WARNING_THRESHOLD) {
      const errorsLine = topErrorsSummary(stat);
      await createAlert({
        severity: 'warning',
        type: 'supermarket_unstable',
        supermarketId: stat.supermarketId,
        title: `${stat.supermarketName} unstable`,
        message: `${stat.failed}/${stat.total} products failing. Top errors: ${errorsLine}`,
        context: {
          run_id: scrapeRunId,
          failure_rate: `${Math.round(failureRate * 100)}%`,
          total: stat.total,
          succeeded: stat.succeeded,
          failed: stat.failed,
          top_errors: errorsLine,
        },
      });
      alertsCreated += 1;
      log.info('created WARNING aggregate alert');
    } else {
      log.debug('no aggregate alert needed');
    }
  }

  return { alertsCreated };
}

/**
 * Create an early supermarket alert before the full run finalizes.
 *
 * This is intentionally conservative: it only fires after enough final failed
 * products exist to make the signal useful, and it de-dupes per run/site/type.
 */
export async function generateEarlyAlertForRunSupermarket(
  scrapeRunId: string | null,
  supermarketId: string,
): Promise<void> {
  if (!scrapeRunId) return;

  const stats = await computeStats(scrapeRunId);
  const stat = stats.find((s) => s.supermarketId === supermarketId);
  if (!stat || stat.total === 0 || stat.failed < EARLY_ALERT_MIN_FAILURES) return;

  const failureRate = stat.failed / stat.total;
  if (failureRate < WARNING_THRESHOLD) return;

  const dom = dominantError(stat);
  const alertType =
    dom && dom.fraction > 0.7 && dom.type === 'selector_failed'
      ? 'selector_broken'
      : dom && dom.fraction > 0.7 && dom.type === 'rate_limited'
        ? 'rate_limited'
        : dom && dom.fraction > 0.7 && dom.type === 'auth_required'
          ? 'auth_required'
          : 'supermarket_unstable';

  if (await hasExistingEarlyAlert(scrapeRunId, supermarketId, alertType)) return;

  const errorsLine = topErrorsSummary(stat);
  await createAlert({
    severity: failureRate >= CRITICAL_THRESHOLD ? 'critical' : 'warning',
    type: alertType,
    supermarketId: stat.supermarketId,
    title: `${stat.supermarketName} failing during run`,
    message: `${stat.failed}/${stat.total} completed products are failing so far. Top errors: ${errorsLine}`,
    context: {
      run_id: scrapeRunId,
      early: true,
      failure_rate_so_far: `${Math.round(failureRate * 100)}%`,
      total_completed_so_far: stat.total,
      succeeded_so_far: stat.succeeded,
      failed_so_far: stat.failed,
      top_errors: errorsLine,
    },
  });
}

async function hasExistingEarlyAlert(
  scrapeRunId: string,
  supermarketId: string,
  alertType: string,
): Promise<boolean> {
  const { data, error } = await db
    .from('alerts')
    .select('context')
    .eq('supermarket_id', supermarketId)
    .eq('type', alertType)
    .eq('status', 'open')
    .limit(20);
  if (error) throw error;

  return (data ?? []).some((row) => {
    const context = row.context as Record<string, unknown>;
    return context.run_id === scrapeRunId && context.early === true;
  });
}

/**
 * Update each supermarket's `health_status` based on this run's stats.
 * Called from the finalizer alongside alert generation.
 */
export async function updateSupermarketHealth(
  scrapeRunId: string,
): Promise<void> {
  const stats = await computeStats(scrapeRunId);
  for (const stat of stats) {
    if (stat.total === 0) continue;
    const failureRate = stat.failed / stat.total;
    let health: 'healthy' | 'degraded' | 'down';
    if (failureRate >= CRITICAL_THRESHOLD) health = 'down';
    else if (failureRate >= WARNING_THRESHOLD) health = 'degraded';
    else health = 'healthy';

    const { error } = await db
      .from('supermarkets')
      .update({
        health_status: health,
        last_run_at: new Date().toISOString(),
      })
      .eq('id', stat.supermarketId);
    if (error) {
      logger.error(
        { err: error, supermarket: stat.supermarketId },
        'failed to update supermarket health',
      );
    }
  }
}
