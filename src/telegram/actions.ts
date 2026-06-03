/**
 * Telegram callback action handlers.
 *
 * Each action corresponds to a button the user can press on an alert message.
 * Actions call the same internal logic the REST API uses (retry, fill), so
 * there's one source of truth for the business logic.
 *
 * All actions receive an alert_id. The handler looks up the alert's context
 * to extract run_id and supermarket_id — this keeps callback_data under
 * Telegram's 64-byte limit.
 *
 * Supported actions:
 *   retry:<alert_id>   Retry all failed products for the alert's supermarket/run
 *   fill:<alert_id>    Fill all failed products with yesterday's price
 *   ack:<alert_id>     Acknowledge the alert (dismiss it)
 */

import { db } from '../shared/db.js';
import { logger } from '../shared/logger.js';
import {
  loadRunDiagnostics,
  type FinalJobOutcome,
} from '../shared/runDiagnostics.js';
import { defaultJobOptions, getQueue, type ScrapeJobData } from '../shared/queue.js';

const log = logger.child({ module: 'telegram-actions' });

export interface ActionResult {
  text: string;
  success: boolean;
}

interface AlertContext {
  alertId: string;
  runId: string;
  supermarketId: string;
}

async function resolveAlertContext(alertId: string | undefined): Promise<AlertContext | null> {
  if (!alertId) return null;

  const { data, error } = await db
    .from('alerts')
    .select('id, supermarket_id, context')
    .eq('id', alertId)
    .maybeSingle();
  if (error || !data) return null;

  const ctx = data.context as Record<string, unknown>;
  const runId = typeof ctx.run_id === 'string' ? ctx.run_id : null;
  const supermarketId = (data.supermarket_id as string) ?? null;

  if (!runId || !supermarketId) return null;
  return { alertId: data.id as string, runId, supermarketId };
}

export async function handleAction(action: string, args: string[]): Promise<ActionResult> {
  try {
    switch (action) {
      case 'retry': {
        const ctx = await resolveAlertContext(args[0]);
        if (!ctx) return { text: 'Could not resolve alert context', success: false };
        return await handleRetry(ctx.runId, ctx.supermarketId);
      }
      case 'fill': {
        const ctx = await resolveAlertContext(args[0]);
        if (!ctx) return { text: 'Could not resolve alert context', success: false };
        return await handleFillYesterday(ctx.runId, ctx.supermarketId);
      }
      case 'ack':
        return await handleAcknowledge(args[0]);
      default:
        return { text: `Unknown action: ${action}`, success: false };
    }
  } catch (err) {
    log.error({ err, action, args }, 'telegram action failed');
    const msg = err instanceof Error ? err.message : String(err);
    return { text: `Error: ${msg}`, success: false };
  }
}

/**
 * Retry all failed products for a supermarket in a given run.
 * Creates a recovery run (same logic as POST /v1/runs/:id/retry-failed).
 */
async function handleRetry(
  runId: string,
  supermarketId: string,
): Promise<ActionResult> {

  const diagnostics = await loadRunDiagnostics(runId);
  if (!diagnostics) return { text: 'Run not found', success: false };

  const failures = diagnostics.finalOutcomes.filter((j) => j.status === 'failed');
  const mappingIds = failures.map((j) => j.supermarket_product_id);
  const mappings = await loadMappings(mappingIds);

  const forSupermarket = failures.filter((f) => {
    const m = mappings.get(f.supermarket_product_id);
    return m?.supermarket_id === supermarketId;
  });

  if (forSupermarket.length === 0) {
    return { text: `No failed products for ${supermarketId}`, success: true };
  }

  const retryRunId = await createRecoveryRun(runId, supermarketId, forSupermarket, mappings);

  return {
    text: `Retrying ${forSupermarket.length} products for ${supermarketId}\nRecovery run: ${retryRunId}`,
    success: true,
  };
}

/**
 * Fill yesterday's price for all failed products of a supermarket in a run.
 * Looks up each product's most recent successful snapshot and inserts a
 * copy with tier_used='manual'.
 */
async function handleFillYesterday(
  runId: string,
  supermarketId: string,
): Promise<ActionResult> {

  const diagnostics = await loadRunDiagnostics(runId);
  if (!diagnostics) return { text: 'Run not found', success: false };

  const failures = diagnostics.finalOutcomes.filter((j) => j.status === 'failed');
  const mappingIds = failures.map((j) => j.supermarket_product_id);
  const mappings = await loadMappings(mappingIds);

  const forSupermarket = failures.filter((f) => {
    const m = mappings.get(f.supermarket_product_id);
    return m?.supermarket_id === supermarketId;
  });

  if (forSupermarket.length === 0) {
    return { text: `No failed products for ${supermarketId}`, success: true };
  }

  let filled = 0;
  let skipped = 0;

  for (const failure of forSupermarket) {
    const lastSnapshot = await loadLatestSuccessfulSnapshot(failure.supermarket_product_id);
    if (!lastSnapshot) {
      skipped += 1;
      continue;
    }

    const { error } = await db.from('price_snapshots').insert({
      supermarket_product_id: failure.supermarket_product_id,
      scrape_run_id: runId,
      scraped_at: new Date().toISOString(),
      price: lastSnapshot.price,
      list_price: lastSnapshot.list_price,
      unit_price: lastSnapshot.unit_price,
      unit_price_per: lastSnapshot.unit_price_per,
      in_stock: lastSnapshot.in_stock,
      currency: lastSnapshot.currency,
      tier_used: 'manual',
      promotions: lastSnapshot.promotions,
      raw_data: {
        source: 'telegram_fill_yesterday',
        copied_from_scraped_at: lastSnapshot.scraped_at,
      },
    });

    if (error) {
      log.error({ err: error, supermarketProductId: failure.supermarket_product_id }, 'fill insert failed');
      skipped += 1;
    } else {
      filled += 1;
    }
  }

  return {
    text: `Filled ${filled} products for ${supermarketId} with yesterday's price` +
      (skipped > 0 ? `\n${skipped} skipped (no previous snapshot)` : ''),
    success: true,
  };
}

async function handleAcknowledge(alertId: string | undefined): Promise<ActionResult> {
  if (!alertId) return { text: 'Missing alert ID', success: false };

  const { error } = await db
    .from('alerts')
    .update({ status: 'acknowledged' })
    .eq('id', alertId)
    .eq('status', 'open');

  if (error) {
    return { text: `Failed to acknowledge: ${error.message}`, success: false };
  }
  return { text: 'Alert acknowledged', success: true };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MappingRow {
  id: string;
  supermarket_id: string;
  external_id: string;
  external_url: string | null;
}

async function loadMappings(ids: string[]): Promise<Map<string, MappingRow>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await db
    .from('supermarket_products')
    .select('id, supermarket_id, external_id, external_url')
    .in('id', ids);
  if (error) throw error;
  return new Map((data ?? []).map((m) => [m.id as string, m as MappingRow]));
}

interface SnapshotRow {
  price: number;
  list_price: number | null;
  unit_price: number | null;
  unit_price_per: string | null;
  in_stock: boolean;
  currency: string;
  promotions: unknown;
  scraped_at: string;
}

async function loadLatestSuccessfulSnapshot(
  supermarketProductId: string,
): Promise<SnapshotRow | null> {
  const { data, error } = await db
    .from('price_snapshots')
    .select('price, list_price, unit_price, unit_price_per, in_stock, currency, promotions, scraped_at')
    .eq('supermarket_product_id', supermarketProductId)
    .order('scraped_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data as SnapshotRow | null;
}

async function createRecoveryRun(
  sourceRunId: string,
  supermarketId: string,
  failures: FinalJobOutcome[],
  mappings: Map<string, MappingRow>,
): Promise<string> {
  const bySupermarket: Record<string, number> = { [supermarketId]: failures.length };

  const { data, error } = await db
    .from('scrape_runs')
    .insert({
      started_at: new Date().toISOString(),
      status: 'running',
      total_jobs: failures.length,
      metadata: {
        recovery: true,
        source: 'telegram',
        source_run_id: sourceRunId,
        by_supermarket: bySupermarket,
      },
    })
    .select('id')
    .single();
  if (error) throw error;
  const retryRunId = data.id as string;

  const jobs: Array<{ name: 'scrape'; data: ScrapeJobData; opts: ReturnType<typeof defaultJobOptions> }> = [];
  for (const failure of failures) {
    const mapping = mappings.get(failure.supermarket_product_id);
    if (!mapping) continue;
    jobs.push({
      name: 'scrape',
      data: {
        supermarketProductId: mapping.id,
        supermarketId: mapping.supermarket_id,
        externalId: mapping.external_id,
        externalUrl: mapping.external_url,
        scrapeRunId: retryRunId,
        attempt: 1,
      },
      opts: defaultJobOptions(),
    });
  }

  if (jobs.length > 0) {
    await getQueue(supermarketId).addBulk(jobs);
  }

  log.info(
    { retryRunId, sourceRunId, supermarketId, count: jobs.length },
    'telegram: created recovery run',
  );

  return retryRunId;
}
