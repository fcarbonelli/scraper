/**
 * DB persistence for the revista layer (magazines + review queue). Replaces the
 * PoC's local JSON files. All revista DB writes live here.
 */

import { db } from '../shared/db.js';
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
  status: 'processing' | 'in_review' | 'reviewed';
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
  const { data, error } = await db
    .from('revista_magazines')
    .upsert(
      {
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
      },
      { onConflict: 'supermarket_id,content_hash' },
    )
    .select('id')
    .single();
  if (error) throw error;
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
 * Current magazines for a chain = every row with superseded_by IS NULL
 * (one per series after supersede). Prefer {@link getCurrentMagazineIds}.
 */
export async function getCurrentMagazineId(supermarketId: string): Promise<string | null> {
  const ids = await getCurrentMagazineIds(supermarketId);
  return ids[0] ?? null;
}

/**
 * All current (non-superseded) magazines for a chain — one per flyer series.
 * Carry-forward iterates these so every active series keeps emitting prices.
 */
export async function getCurrentMagazineIds(supermarketId: string): Promise<string[]> {
  const { data, error } = await db
    .from('revista_magazines')
    .select('id')
    .eq('supermarket_id', supermarketId)
    .is('superseded_by', null)
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
  const rows = items.map(({ result, pageImageUrl }) => ({
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
    proposed_product_id: result.matched?.id ?? null,
    confidence: Math.round(result.confidence * 1000) / 1000,
    method: result.method === 'none' ? 'manual' : result.method,
    reason: result.reason,
    candidates: result.candidates.map((c) => ({
      id: c.id,
      name: c.name,
      brand: c.brand ?? null,
      quantity: c.quantity ?? null,
      ean: c.ean ?? null,
    })),
    status: 'pending' as const,
  }));

  const { error } = await db.from('revista_review_items').insert(rows);
  if (error) throw error;
}
