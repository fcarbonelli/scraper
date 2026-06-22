/**
 * Run publication & gap reconciliation.
 *
 * A finished daily run sits in `review_status = 'pending_review'` and is
 * invisible to the client until an operator publishes it. Publishing:
 *
 *   1. Computes the run's remaining GAPS (products that failed and were not
 *      fixed by a re-run or a manual price).
 *   2. Inserts ONE no-price marker `price_snapshots` row per unresolved gap so
 *      every attempted product has a record for the day (gap-free internally).
 *   3. Flips the run — and any recovery runs spawned from it — to 'published'.
 *
 * The `client_base` view then serves the day. Internal-only `scrape_failed`
 * markers are filtered out of the client view (they describe our pipeline, not
 * the product), but stay in the DB for audit.
 *
 * This module is pure logic over the DB — it's called by the API routes
 * (publish / review / flag) and is queue-agnostic.
 */

import { db, fetchAllPages, fetchInChunks } from '../shared/db.js';
import { loadRunDiagnostics } from '../shared/runDiagnostics.js';
import { ApiError } from '../api/lib/apiError.js';

// =============================================================================
// Status model
// =============================================================================

/** Client-facing, real-world product situations. */
export type ClientVisibleStatus = 'ok' | 'out_of_stock' | 'not_found' | 'delisted';
/** Full set of snapshot statuses, incl. the internal-only failure marker. */
export type SnapshotStatus = ClientVisibleStatus | 'scrape_failed';

/** Statuses an operator can assign by hand via the flag endpoint. */
export const FLAGGABLE_STATUSES = ['out_of_stock', 'not_found', 'delisted'] as const;
export type FlaggableStatus = (typeof FLAGGABLE_STATUSES)[number];

/** Product-level lifecycle states stored on supermarket_products. */
export const LIFECYCLE_STATUSES = ['active', 'out_of_stock', 'delisted'] as const;
export type LifecycleStatus = (typeof LIFECYCLE_STATUSES)[number];

/**
 * Decide the marker status for an unresolved gap at publish time:
 *   - a delisted/out_of_stock mapping lifecycle wins (it's a known real state);
 *   - a 404 ('product_not_found') maps to 'not_found';
 *   - everything else is an internal 'scrape_failed' (hidden from the client).
 */
export function markerStatusForGap(
  lifecycle: string | null | undefined,
  errorType: string | null | undefined,
): SnapshotStatus {
  if (lifecycle === 'delisted') return 'delisted';
  if (lifecycle === 'out_of_stock') return 'out_of_stock';
  if (errorType === 'product_not_found') return 'not_found';
  return 'scrape_failed';
}

// =============================================================================
// Gap / review computation
// =============================================================================

export interface RunGap {
  supermarket_product_id: string;
  supermarket_id: string;
  ean: string | null;
  name: string | null;
  external_url: string | null;
  error_type: string | null;
  error_message: string | null;
  lifecycle_status: LifecycleStatus;
  /** What status the marker would get if published as-is. */
  resolved_status: SnapshotStatus;
}

export interface RunReview {
  run: {
    id: string;
    status: string;
    review_status: string;
    started_at: string;
    finished_at: string | null;
    total_jobs: number;
    published_at: string | null;
  };
  coverage: {
    expected: number;
    succeeded: number;
    resolved_by_fix: number;
    gaps: number;
    coveragePct: number;
  };
  bySupermarket: Array<{
    supermarket_id: string;
    total: number;
    succeeded: number;
    failed: number;
    gaps: number;
  }>;
  gaps: RunGap[];
  recovery_run_ids: string[];
}

interface GapMappingDetail {
  id: string;
  supermarket_id: string;
  external_url: string | null;
  lifecycle_status: LifecycleStatus;
  products?: { name: string | null; ean: string | null } | Array<{ name: string | null; ean: string | null }> | null;
}

function firstJoined<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/** Recovery runs are those whose metadata.source_run_id points at this run. */
async function loadRecoveryRunIds(runId: string): Promise<string[]> {
  const { data, error } = await db
    .from('scrape_runs')
    .select('id')
    .eq('metadata->>source_run_id', runId);
  if (error) throw error;
  return (data ?? []).map((r) => r.id as string);
}

/** Distinct mappings that already have a snapshot in the given run-set. */
async function loadMappingsWithSnapshot(runIds: string[]): Promise<Set<string>> {
  if (runIds.length === 0) return new Set();
  const rows = await fetchAllPages<{ supermarket_product_id: string }>((from, to) =>
    db
      .from('price_snapshots')
      .select('supermarket_product_id')
      .in('scrape_run_id', runIds)
      .order('id', { ascending: true })
      .range(from, to),
  );
  return new Set(rows.map((r) => r.supermarket_product_id));
}

async function loadGapMappingDetails(
  mappingIds: string[],
): Promise<Map<string, GapMappingDetail>> {
  if (mappingIds.length === 0) return new Map();
  const rows = await fetchInChunks<GapMappingDetail>(mappingIds, (chunk) =>
    db
      .from('supermarket_products')
      .select('id, supermarket_id, external_url, lifecycle_status, products:product_id ( name, ean )')
      .in('id', chunk),
  );
  return new Map(rows.map((m) => [m.id, m]));
}

/**
 * Build the review summary for a run: coverage numbers + the unresolved gap
 * list the operator must act on before publishing. Throws NOT_FOUND if the run
 * does not exist.
 */
export async function computeRunReview(runId: string): Promise<RunReview> {
  const diagnostics = await loadRunDiagnostics(runId);
  if (!diagnostics) throw ApiError.notFound('Run');

  const { run, finalOutcomes, progress } = diagnostics;

  const failedOutcomes = finalOutcomes.filter((o) => o.status === 'failed');
  const recoveryRunIds = await loadRecoveryRunIds(runId);
  const runSet = [runId, ...recoveryRunIds];
  const resolvedMappings = await loadMappingsWithSnapshot(runSet);

  // A failed product is a gap only if nothing produced a snapshot for it in the
  // run-set (no successful re-run, no operator-entered price/flag tied to a run).
  const unresolvedFailed = failedOutcomes.filter(
    (o) => !resolvedMappings.has(o.supermarket_product_id),
  );
  const resolvedByFix = failedOutcomes.length - unresolvedFailed.length;

  const details = await loadGapMappingDetails(
    unresolvedFailed.map((o) => o.supermarket_product_id),
  );

  const gaps: RunGap[] = unresolvedFailed.map((o) => {
    const mapping = details.get(o.supermarket_product_id);
    const product = firstJoined(mapping?.products);
    const lifecycle = (mapping?.lifecycle_status ?? 'active') as LifecycleStatus;
    return {
      supermarket_product_id: o.supermarket_product_id,
      supermarket_id: mapping?.supermarket_id ?? 'unknown',
      ean: product?.ean ?? null,
      name: product?.name ?? null,
      external_url: mapping?.external_url ?? null,
      error_type: o.error_type,
      error_message: o.error_message,
      lifecycle_status: lifecycle,
      resolved_status: markerStatusForGap(lifecycle, o.error_type),
    };
  });

  const gapsBySupermarket = new Map<string, number>();
  for (const g of gaps) {
    gapsBySupermarket.set(g.supermarket_id, (gapsBySupermarket.get(g.supermarket_id) ?? 0) + 1);
  }

  const bySupermarket = Object.entries(progress.by_supermarket).map(([smId, p]) => ({
    supermarket_id: smId,
    total: p.total,
    succeeded: p.succeeded,
    failed: p.failed,
    gaps: gapsBySupermarket.get(smId) ?? 0,
  }));

  const expected = Math.max(progress.total_jobs, finalOutcomes.length);
  const coveredCount = progress.succeeded + resolvedByFix;

  return {
    run: {
      id: run.id,
      status: run.status,
      review_status: run.review_status,
      started_at: run.started_at,
      finished_at: run.finished_at,
      total_jobs: run.total_jobs,
      published_at: run.published_at,
    },
    coverage: {
      expected,
      succeeded: progress.succeeded,
      resolved_by_fix: resolvedByFix,
      gaps: gaps.length,
      coveragePct: expected > 0 ? Math.round((coveredCount / expected) * 1000) / 10 : 0,
    },
    bySupermarket,
    gaps,
    recovery_run_ids: recoveryRunIds,
  };
}

// =============================================================================
// Marker insertion
// =============================================================================

export interface MarkerRowInput {
  supermarketProductId: string;
  scrapeRunId: string;
  status: SnapshotStatus;
  errorType?: string | null;
  note?: string | null;
  source: string;
}

/** Insert no-price marker snapshot rows (chunked to keep payloads small). */
export async function insertMarkerRows(markers: MarkerRowInput[]): Promise<number> {
  if (markers.length === 0) return 0;
  const nowIso = new Date().toISOString();
  const rows = markers.map((m) => ({
    supermarket_product_id: m.supermarketProductId,
    scrape_run_id: m.scrapeRunId,
    scraped_at: nowIso,
    price: null,
    list_price: null,
    unit_price: null,
    unit_price_per: null,
    in_stock: false,
    currency: 'ARS',
    tier_used: 'marker',
    status: m.status,
    promotions: [],
    raw_data: { source: m.source, error_type: m.errorType ?? null, note: m.note ?? null },
  }));

  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await db.from('price_snapshots').insert(rows.slice(i, i + CHUNK));
    if (error) throw error;
  }
  return rows.length;
}

// =============================================================================
// Publish
// =============================================================================

export interface PublishArgs {
  runId: string;
  publishedBy: string;
  /** Publish even if unresolved gaps remain (they get scrape_failed markers). */
  force?: boolean;
}

export type PublishResult =
  | { published: false; gaps: number; review: RunReview }
  | {
      published: true;
      markers_inserted: number;
      published_run_ids: string[];
      published_at: string;
    };

/**
 * Publish a run. With unresolved gaps and `force` not set, returns
 * `{ published: false }` so the caller can prompt. With `force` (or no gaps),
 * inserts markers for any remaining gaps and flips the run + its recovery runs
 * to 'published'. Idempotent: re-publishing only fills NEW gaps.
 */
export async function publishRun(args: PublishArgs): Promise<PublishResult> {
  const review = await computeRunReview(args.runId);

  if (review.gaps.length > 0 && !args.force) {
    return { published: false, gaps: review.gaps.length, review };
  }

  const markersInserted = await insertMarkerRows(
    review.gaps.map((g) => ({
      supermarketProductId: g.supermarket_product_id,
      scrapeRunId: args.runId,
      status: g.resolved_status,
      errorType: g.error_type,
      source: 'publish_reconcile',
    })),
  );

  const publishedAt = new Date().toISOString();
  const runIds = [args.runId, ...review.recovery_run_ids];
  const { error } = await db
    .from('scrape_runs')
    .update({
      review_status: 'published',
      published_at: publishedAt,
      published_by: args.publishedBy,
    })
    .in('id', runIds);
  if (error) throw error;

  return {
    published: true,
    markers_inserted: markersInserted,
    published_run_ids: runIds,
    published_at: publishedAt,
  };
}
