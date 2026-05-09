/**
 * Database write helpers for the scraping pipeline.
 *
 * All DB access for scraping flows through here so the worker logic stays
 * focused on orchestration. Each function does ONE thing and returns minimal
 * data needed by the caller.
 */

import { db } from '../shared/db.js';
import type { Logger } from '../shared/logger.js';
import type { ScrapeResult } from '../adapters/types.js';
import type { ClassifiedError } from './classifyError.js';

// =============================================================================
// Types matching DB rows we read
// =============================================================================

export interface JobInputRow {
  supermarketProduct: {
    id: string;
    supermarketId: string;
    externalId: string;
    externalUrl: string | null;
    productId: string;
  };
  supermarket: {
    id: string;
    name: string;
    baseUrl: string | null;
    rateLimitMs: number;
    concurrency: number;
    config: Record<string, unknown>;
  };
}

// =============================================================================
// Loaders
// =============================================================================

/**
 * Load the supermarket_product + its parent supermarket in one trip.
 * Returns null if either row is missing or the supermarket is inactive.
 */
export async function loadJobInput(
  supermarketProductId: string,
): Promise<JobInputRow | null> {
  const { data, error } = await db
    .from('supermarket_products')
    .select(
      `
      id,
      supermarket_id,
      product_id,
      external_id,
      external_url,
      is_active,
      supermarkets:supermarket_id (
        id,
        name,
        is_active,
        base_url,
        rate_limit_ms,
        concurrency,
        config
      )
    `,
    )
    .eq('id', supermarketProductId)
    .maybeSingle();

  if (error) throw error;
  if (!data || !data.is_active) return null;

  // The Supabase types resolve the joined row as either an object or array
  // depending on inference; defend against both shapes.
  const supermarketRaw = Array.isArray(data.supermarkets)
    ? data.supermarkets[0]
    : data.supermarkets;
  if (!supermarketRaw || !supermarketRaw.is_active) return null;

  return {
    supermarketProduct: {
      id: data.id,
      supermarketId: data.supermarket_id,
      externalId: data.external_id,
      externalUrl: data.external_url,
      productId: data.product_id,
    },
    supermarket: {
      id: supermarketRaw.id,
      name: supermarketRaw.name,
      baseUrl: supermarketRaw.base_url,
      rateLimitMs: supermarketRaw.rate_limit_ms,
      concurrency: supermarketRaw.concurrency,
      config: (supermarketRaw.config as Record<string, unknown>) ?? {},
    },
  };
}

// =============================================================================
// Job lifecycle: start -> success | failure
// =============================================================================

export interface RecordJobStartArgs {
  scrapeRunId: string | null;
  supermarketProductId: string;
  attempt: number;
}

/** Insert a `running` row in job_executions and return its id. */
export async function recordJobStart(
  args: RecordJobStartArgs,
): Promise<string> {
  const { data, error } = await db
    .from('job_executions')
    .insert({
      scrape_run_id: args.scrapeRunId,
      supermarket_product_id: args.supermarketProductId,
      attempt: args.attempt,
      status: 'retrying',          // 'success' or 'failed' set on completion
      started_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (error) throw error;
  return data.id as string;
}

export interface RecordJobSuccessArgs {
  jobExecutionId: string;
  scrapeRunId: string | null;
  supermarketProductId: string;
  result: ScrapeResult;
  durationMs: number;
  logger?: Logger;
}

/**
 * Mark the job as successful AND insert the corresponding price_snapshots row.
 * Done as two writes (no transaction) — safe because:
 *   - if snapshot insert fails, job_execution is still marked success but no
 *     snapshot exists; the next run will try again. The error is logged.
 */
export async function recordJobSuccess(
  args: RecordJobSuccessArgs,
): Promise<void> {
  const { jobExecutionId, scrapeRunId, supermarketProductId, result, durationMs } = args;
  const finishedAt = new Date().toISOString();

  // 1. price_snapshots row
  const snapshotInsert = db.from('price_snapshots').insert({
    supermarket_product_id: supermarketProductId,
    scrape_run_id: scrapeRunId,
    scraped_at: finishedAt,
    price: result.price,
    list_price: result.listPrice ?? null,
    unit_price: result.unitPrice ?? null,
    unit_price_per: result.unitPricePer ?? null,
    in_stock: result.inStock,
    currency: result.currency,
    tier_used: result.tierUsed,
    promotions: result.promotions ?? [],
    raw_data: result.rawData ?? {},
  });

  // 2. job_executions update
  const jobUpdate = db
    .from('job_executions')
    .update({
      status: 'success',
      tier_used: result.tierUsed,
      duration_ms: durationMs,
      finished_at: finishedAt,
      error_type: null,
      error_message: null,
      error_stack: null,
    })
    .eq('id', jobExecutionId);

  const [snapRes, jobRes] = await Promise.all([snapshotInsert, jobUpdate]);
  if (snapRes.error) {
    args.logger?.error(
      { err: snapRes.error, supermarketProductId },
      'failed to insert price_snapshot (job marked success anyway)',
    );
    throw snapRes.error;
  }
  if (jobRes.error) throw jobRes.error;
}

export interface RecordJobFailureArgs {
  jobExecutionId: string;
  error: ClassifiedError;
  durationMs: number;
  /** True when this attempt was the last (no more retries scheduled). */
  isFinal: boolean;
}

/** Mark the job as failed (or "retrying" if more attempts will happen). */
export async function recordJobFailure(
  args: RecordJobFailureArgs,
): Promise<void> {
  const { error } = await db
    .from('job_executions')
    .update({
      status: args.isFinal ? 'failed' : 'retrying',
      duration_ms: args.durationMs,
      finished_at: new Date().toISOString(),
      error_type: args.error.type,
      error_message: args.error.message.slice(0, 2000),
      error_stack: args.error.stack?.slice(0, 8000) ?? null,
    })
    .eq('id', args.jobExecutionId);
  if (error) throw error;
}
