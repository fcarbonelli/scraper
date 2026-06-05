/**
 * Database write helpers for the scraping pipeline.
 *
 * All DB access for scraping flows through here so the worker logic stays
 * focused on orchestration. Each function does ONE thing and returns minimal
 * data needed by the caller.
 */

import { db } from '../shared/db.js';
import type { Logger } from '../shared/logger.js';
import type { Promotion, ScrapeResult } from '../adapters/types.js';
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
// Promotion flattening — extract the first two promotions into discrete columns
// =============================================================================

interface FlatPromotions {
  promotion_1: string | null;
  promotion_2: string | null;
  offer_price_1: number | null;
  offer_price_2: number | null;
  unit_discount: number | null;
}

/**
 * Flatten the promotions array into the discrete columns the client expects.
 * Computes offer prices from discount percentages when available.
 */
function flattenPromotions(
  promotions: Promotion[] | undefined,
  regularPrice: number,
): FlatPromotions {
  const promos = promotions ?? [];
  const p1 = promos[0];
  const p2 = promos[1];

  const computeOfferPrice = (promo: Promotion | undefined): number | null => {
    if (!promo) return null;
    if (promo.discountPct != null && promo.discountPct > 0) {
      return Math.round(regularPrice * (1 - promo.discountPct) * 100) / 100;
    }
    if (promo.discountAmount != null && promo.discountAmount > 0) {
      return Math.round((regularPrice - promo.discountAmount) * 100) / 100;
    }
    return null;
  };

  // Unit discount = largest percentage discount across all promotions
  let maxDiscountPct: number | null = null;
  for (const promo of promos) {
    if (promo.discountPct != null && promo.discountPct > 0) {
      if (maxDiscountPct === null || promo.discountPct > maxDiscountPct) {
        maxDiscountPct = promo.discountPct;
      }
    }
  }

  return {
    promotion_1: p1?.description ?? null,
    promotion_2: p2?.description ?? null,
    offer_price_1: computeOfferPrice(p1),
    offer_price_2: computeOfferPrice(p2),
    unit_discount: maxDiscountPct,
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
  const flat = flattenPromotions(result.promotions, result.price);

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
    // Record which geographic zone produced this snapshot. `zoneUsed` is only
    // set when a location-aware adapter had to fall back from the default zone
    // (see src/adapters/geo-retry.ts); otherwise it's the default zone.
    raw_data: {
      ...(result.rawData ?? {}),
      zoneUsed: result.zoneUsed ?? 'default',
    },
    offer_price_1: flat.offer_price_1,
    offer_price_2: flat.offer_price_2,
    promotion_1: flat.promotion_1,
    promotion_2: flat.promotion_2,
    unit_discount: flat.unit_discount,
    site_product_name: result.productInfo?.name ?? null,
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
