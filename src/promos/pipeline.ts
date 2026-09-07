/**
 * Promotions pipeline — the weekly entry point.
 *
 * `runPromoCheck()` is called by the orchestrator (weekly cron) and by the
 * `promos:run` script. For each active provider it fetches the current
 * promotions, persists them with a weekly snapshot, and deactivates the ones
 * that dropped off. Each provider is isolated: a failure in one never aborts
 * the others.
 */

import { randomUUID } from 'node:crypto';
import { db } from '../shared/db.js';
import { logger } from '../shared/logger.js';
import { promosConfig } from './config.js';
import { getProvider } from './registry.js';
import { markProviderRun, persistProviderPromotions } from './store.js';
import type { ProviderRunSummary } from './types.js';

export interface RunPromoOptions {
  /** Restrict the run to a single provider id. */
  providerId?: string;
  /** Reuse an existing run id (else a fresh one is generated). */
  runId?: string;
  /** Fetch + normalize but do NOT write to the DB (for testing). */
  dryRun?: boolean;
  /** Run even when PROMOS_ENABLED=false (manual/CLI trigger). */
  force?: boolean;
}

interface ProviderRow {
  id: string;
  config: Record<string, unknown> | null;
}

/** Run the promotions check across all active (or one) providers. */
export async function runPromoCheck(
  opts: RunPromoOptions = {},
): Promise<ProviderRunSummary[]> {
  const shouldRun = promosConfig.enabled || opts.force || opts.dryRun === true;
  if (!shouldRun) {
    logger.info('promos: disabled via PROMOS_ENABLED=false, skipping');
    return [];
  }

  const runId = opts.runId ?? randomUUID();
  const rows = await loadActiveProviders(opts.providerId);
  if (rows.length === 0) {
    logger.warn({ providerId: opts.providerId }, 'promos: no active providers to run');
    return [];
  }

  const summaries: ProviderRunSummary[] = [];
  for (const row of rows) {
    const provider = getProvider(row.id);
    if (!provider) {
      logger.warn({ providerId: row.id }, 'promos: active provider has no registered impl, skipping');
      continue;
    }
    const log = logger.child({ provider: row.id, runId });
    try {
      // AbortSignal.timeout guards against a hung network call wedging the run.
      const signal = AbortSignal.timeout(promosConfig.runTimeoutMs);
      const promos = await provider.fetchAll({
        logger,
        config: row.config ?? {},
        signal,
      });
      log.info({ fetched: promos.length }, 'promos: provider fetch complete');

      if (opts.dryRun) {
        summaries.push({
          providerId: row.id,
          fetched: promos.length,
          upserted: 0,
          created: 0,
          snapshotted: 0,
          unchanged: 0,
          deactivated: 0,
        });
        continue;
      }

      const summary = await persistProviderPromotions(row.id, promos, runId);
      await markProviderRun(row.id);
      summaries.push(summary);
    } catch (err) {
      log.error({ err }, 'promos: provider run failed');
      summaries.push({
        providerId: row.id,
        fetched: 0,
        upserted: 0,
        created: 0,
        snapshotted: 0,
        unchanged: 0,
        deactivated: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info({ runId, summaries }, 'promos: run complete');
  return summaries;
}

/** Load active providers (optionally one) from promo_providers. */
async function loadActiveProviders(providerId?: string): Promise<ProviderRow[]> {
  let query = db.from('promo_providers').select('id, config').eq('active', true);
  if (providerId) query = query.eq('id', providerId);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map((r) => ({
    id: r.id as string,
    config: (r.config as Record<string, unknown> | null) ?? {},
  }));
}
