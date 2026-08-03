/**
 * DB persistence for the revista layer (magazines + review queue). Replaces the
 * PoC's local JSON files. All revista DB writes live here.
 */

import { db } from '../shared/db.js';
import { parseFlyerPeriod } from './period.js';
import type { MatchResult } from './match.js';

export interface MagazineRow {
  id: string;
  supermarket_id: string;
  label: string;
  source_strategy: string;
  source_url: string | null;
  content_hash: string;
  file_size: number | null;
  page_count: number;
  status: 'processing' | 'in_review' | 'reviewed' | 'failed';
  scrape_run_id: string | null;
  detected_at: string;
  reviewed_at: string | null;
  /** Newer magazine that replaced this issue (NULL = still current). */
  superseded_by: string | null;
  superseded_at: string | null;
  /**
   * Flyer series within the chain (e.g. 'mm', 'gt', 'folder-resto').
   * Supersede / carry-forward scope to (supermarket_id, series_key).
   */
  series_key: string;
  /**
   * Manual on/off switch (migration 018). false = this issue is excluded from
   * the daily carry-forward and its approved prices are dropped from the client
   * base, without un-approving each product. Orthogonal to superseded_by.
   */
  carry_active: boolean;
  /**
   * Validity the flyer declares in its own title (migration 023). NULL whenever
   * the label carries no parseable period — Rosental titles and Makro filenames
   * usually don't. Never a key; identity stays `content_hash`.
   */
  period_start?: string | null;
  period_end?: string | null;
  /**
   * How the period was obtained. Persisted rather than assumed: a fortnight
   * inferred from "Agosto primera quincena" must not come back out of the
   * database claiming to be an exact reading, because the re-upload guard
   * requires both sides `exact` before it skips anything.
   */
  period_confidence?: 'exact' | 'inferred' | null;
}

/** Look up a magazine by its dedup hash (the "did it change?" check). */
export async function findMagazineByHash(
  supermarketId: string,
  contentHash: string,
): Promise<MagazineRow | null> {
  const { data, error } = await db
    .from('revista_magazines')
    .select('*')
    .eq('supermarket_id', supermarketId)
    .eq('content_hash', contentHash)
    .maybeSingle();
  if (error) throw error;
  return (data as MagazineRow | null) ?? null;
}

export interface CreateMagazineArgs {
  supermarketId: string;
  label: string;
  strategy: string;
  sourceUrl: string;
  contentHash: string;
  fileSize: number;
  pageCount: number;
  scrapeRunId: string | null;
  /** Flyer series key; defaults to 'default' for single-series chains. */
  seriesKey?: string;
}

/**
 * Upsert a magazine row in `processing` state and return its id.
 *
 * Upsert (not insert) on the (supermarket_id, content_hash) unique key so that
 * REPROCESSING the same issue — a `--force` run, or retrying a row stuck in
 * `processing` after a crash — reuses the existing row instead of hitting a
 * duplicate-key error. Resets it back to `processing` and clears the review
 * timestamp; the caller then re-fills the review queue and flips it to
 * `in_review`.
 */
export async function createMagazine(args: CreateMagazineArgs): Promise<string> {
  // Anchored to now because a candidate only reaches here after being found on
  // the chain's site, so "now" is within days of the period it advertises. The
  // exception is `--url` re-ingesting a months-old PDF by hand, where the
  // December-wrap correction could pick the wrong year.
  const period = parseFlyerPeriod(args.label, new Date());
  const columns: Record<string, unknown> = {
    supermarket_id: args.supermarketId,
    label: args.label,
    source_strategy: args.strategy,
    source_url: args.sourceUrl,
    content_hash: args.contentHash,
    file_size: args.fileSize,
    page_count: args.pageCount,
    status: 'processing',
    scrape_run_id: args.scrapeRunId,
    reviewed_at: null,
    series_key: args.seriesKey ?? 'default',
    // A --force reprocess of the current issue must clear any stale
    // supersede pointer so it becomes "current" again for its series.
    superseded_by: null,
    superseded_at: null,
    period_start: period?.start ?? null,
    period_end: period?.end ?? null,
    period_confidence: period?.confidence ?? null,
  };

  const upsert = (cols: Record<string, unknown>) =>
    db
      .from('revista_magazines')
      .upsert(cols, { onConflict: 'supermarket_id,content_hash' })
      .select('id')
      .single();

  let { data, error } = await upsert(columns);
  // Migration 023 may not be applied yet (code can reach the server first).
  // Losing the period is acceptable; losing the whole ingestion is not.
  if (error && String(error.message ?? '').includes('period_')) {
    const { period_start: _s, period_end: _e, period_confidence: _c, ...withoutPeriod } = columns;
    ({ data, error } = await upsert(withoutPeriod));
  }
  if (error) throw error;
  if (!data) throw new Error('createMagazine: upsert returned no row');
  return data.id as string;
}

export async function setMagazineStatus(
  magazineId: string,
  status: MagazineRow['status'],
): Promise<void> {
  const patch: Record<string, unknown> = { status };
  if (status === 'reviewed') patch.reviewed_at = new Date().toISOString();
  const { error } = await db.from('revista_magazines').update(patch).eq('id', magazineId);
  if (error) throw error;
}

/**
 * Mark every older (non-superseded) magazine of the SAME SERIES for this chain
 * as superseded by `newMagazineId`. Called when a new issue reaches `in_review`.
 *
 * Scoping by series_key is required: Makro/Vital publish several concurrent
 * flyer series, and a new MM must not kill GT / Folder prices.
 *
 * Only magazines with `detected_at` strictly before the new one are marked —
 * so a `--force` reprocess of an old hash cannot demote a newer current issue.
 * Returns the ids that were marked (empty when this is the first / oldest
 * issue of that series).
 */
export async function supersedePreviousMagazines(
  supermarketId: string,
  newMagazineId: string,
): Promise<string[]> {
  const { data: neu, error: neuErr } = await db
    .from('revista_magazines')
    .select('id, detected_at, series_key')
    .eq('id', newMagazineId)
    .single();
  if (neuErr) throw neuErr;

  const seriesKey = (neu.series_key as string | null) ?? 'default';

  const { data, error } = await db
    .from('revista_magazines')
    .select('id')
    .eq('supermarket_id', supermarketId)
    .eq('series_key', seriesKey)
    .is('superseded_by', null)
    .neq('id', newMagazineId)
    .lt('detected_at', neu.detected_at as string);
  if (error) throw error;

  const ids = (data ?? []).map((r) => r.id as string);
  if (ids.length === 0) return [];

  const { error: updErr } = await db
    .from('revista_magazines')
    .update({
      superseded_by: newMagazineId,
      superseded_at: new Date().toISOString(),
    })
    .in('id', ids);
  if (updErr) throw updErr;
  return ids;
}

/**
 * The magazine currently standing for one series of one chain.
 *
 * Two filters that look redundant and are not:
 *
 * - `superseded_by IS NULL` alone is not enough. `supersedePreviousMagazines`
 *   only runs on the transition to `in_review`, so a row that crashed mid-run
 *   and is stuck in `processing` was never superseded and never superseded
 *   anyone. Production currently holds six such rows, the oldest a month old.
 * - Hence `status IN ('in_review','reviewed')`: a stuck row is a corpse, not
 *   the current issue.
 *
 * Deliberately NOT `.maybeSingle()` — that throws on the duplicate this very
 * situation produces. Order and take the first instead.
 */
export async function findCurrentMagazineInSeries(
  supermarketId: string,
  seriesKey: string,
): Promise<MagazineRow | null> {
  const { data, error } = await db
    .from('revista_magazines')
    .select('*')
    .eq('supermarket_id', supermarketId)
    .eq('series_key', seriesKey)
    .is('superseded_by', null)
    .in('status', ['in_review', 'reviewed'])
    .order('detected_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return (data?.[0] as MagazineRow | undefined) ?? null;
}

/**
 * Current magazines for a chain = every row with superseded_by IS NULL
 * (one per series after supersede). Prefer {@link getCurrentMagazineIds}.
 */
export async function getCurrentMagazineId(supermarketId: string): Promise<string | null> {
  const ids = await getCurrentMagazineIds(supermarketId);
  return ids[0] ?? null;
}

/**
 * All current (non-superseded) AND carry-active magazines for a chain — one per
 * flyer series. Carry-forward iterates these so every active series keeps
 * emitting prices. A manually deactivated issue (carry_active=false) is excluded
 * here so it stops feeding the client base immediately.
 */
export async function getCurrentMagazineIds(supermarketId: string): Promise<string[]> {
  const { data, error } = await db
    .from('revista_magazines')
    .select('id')
    .eq('supermarket_id', supermarketId)
    .is('superseded_by', null)
    .eq('carry_active', true)
    .order('detected_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map((r) => r.id as string);
}

/** Replace any existing review items for a magazine (idempotent reprocessing). */
export async function clearReviewItems(magazineId: string): Promise<void> {
  const { error } = await db.from('revista_review_items').delete().eq('magazine_id', magazineId);
  if (error) throw error;
}

export interface ReviewItemInput {
  result: MatchResult;
  pageImageUrl: string | null;
}

/** Bulk-insert the review queue for a magazine. */
export async function insertReviewItems(
  magazineId: string,
  supermarketId: string,
  items: ReviewItemInput[],
): Promise<void> {
  if (items.length === 0) return;

  // Match identity is the Catálogo EAN. Resolve an existing master product_id
  // when one already has that EAN (display join); otherwise leave null until approve.
  const matchedEans = [
    ...new Set(
      items
        .map(({ result }) => result.matched?.ean ?? result.matched?.id ?? null)
        .filter((e): e is string => Boolean(e))
        .map((e) => e.replace(/\D/g, ''))
        .filter(Boolean),
    ),
  ];
  const productIdByEan = new Map<string, string>();
  if (matchedEans.length > 0) {
    const { data, error } = await db
      .from('products')
      .select('id, ean')
      .in('ean', matchedEans)
      .order('created_at', { ascending: true });
    if (error) throw error;
    for (const row of data ?? []) {
      const ean = typeof row.ean === 'string' ? row.ean.replace(/\D/g, '') : '';
      if (ean && !productIdByEan.has(ean)) productIdByEan.set(ean, row.id as string);
    }
  }

  const rows = items.map(({ result, pageImageUrl }) => {
    const proposedEan = result.matched
      ? (result.matched.ean ?? result.matched.id).replace(/\D/g, '') || null
      : null;
    return {
      magazine_id: magazineId,
      supermarket_id: supermarketId,
      page_number: result.page,
      page_image_url: pageImageUrl,
      extracted: {
        name: result.item.name,
        brand: result.item.brand,
        ean: result.item.ean,
        price: result.item.price,
        promo_price: result.item.promo_price,
        promo_text: result.item.promo_text,
        quantity: result.item.quantity,
      },
      proposed_ean: proposedEan,
      proposed_product_id: proposedEan ? (productIdByEan.get(proposedEan) ?? null) : null,
      confidence: Math.round(result.confidence * 1000) / 1000,
      method: result.method === 'none' ? 'manual' : result.method,
      reason: result.reason,
      candidates: result.candidates.map((c) => ({
        ean: c.ean ?? c.id,
        name: c.name,
        brand: c.brand ?? null,
        quantity: c.quantity ?? null,
      })),
      status: 'pending' as const,
    };
  });

  const { error } = await db.from('revista_review_items').insert(rows);
  if (error) throw error;
}
