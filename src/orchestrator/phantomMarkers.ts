/**
 * Phantom "siempre No encontrado" markers.
 *
 * Some catalog products must be REPORTED to the client every day even though
 * they have no scrapeable URL — the store carries the product but never
 * publishes it online, so there is no page to fetch. Example: DÍA lavandina en
 * gel 700 ml (EAN 8480017163226) is in the client's catalog and sold at DÍA,
 * but absent from diaonline.
 *
 * We model these as ordinary `supermarket_products` mappings tagged
 * `metadata.source = 'phantom'`:
 *   - The orchestrator's enqueue step SKIPS them (see enqueue.ts) — no adapter
 *     could scrape them, so a job would only ever fail.
 *   - This module emits ONE run-less `not_found` snapshot per phantom per day.
 *
 * Run-less snapshots (scrape_run_id NULL) publish immediately — the client_base
 * publication gate is `(r.id IS NULL OR r.review_status = 'published')` — so the
 * product surfaces as "No encontrado" for the day with no operator action,
 * exactly like the in-store / revista carry-forward markers.
 *
 * Idempotent: re-running on the same UTC day is a no-op (one row per day, which
 * lines up with client_base's `scraped_at::date` day grouping).
 */

import { db } from '../shared/db.js';
import { logger } from '../shared/logger.js';

/** Per-mapping source tag that marks a phantom "always not found" placeholder. */
export const PHANTOM_SOURCE = 'phantom';

interface PhantomRow {
  id: string;
  supermarket_id: string;
  is_active: boolean;
  supermarkets: { is_active: boolean } | { is_active: boolean }[] | null;
  products: { ean: string | null } | { ean: string | null }[] | null;
}

function firstJoined<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/**
 * Active phantom mappings on active supermarkets whose product carries an EAN
 * (the client_base EAN guard would hide it otherwise).
 */
async function loadActivePhantomMappings(): Promise<string[]> {
  const { data, error } = await db
    .from('supermarket_products')
    .select('id, supermarket_id, is_active, supermarkets:supermarket_id ( is_active ), products:product_id ( ean )')
    .eq('is_active', true)
    .eq('metadata->>source', PHANTOM_SOURCE);
  if (error) throw error;

  return ((data ?? []) as PhantomRow[])
    .filter((r) => {
      const sm = firstJoined(r.supermarkets);
      const p = firstJoined(r.products);
      return sm?.is_active === true && (p?.ean ?? '') !== '';
    })
    .map((r) => r.id);
}

/** UTC start-of-day ISO string (00:00:00.000Z) for `now`. */
function startOfUtcDay(now: Date): string {
  return `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
}

/** Mapping ids that already have ANY snapshot today (UTC), so we don't dupe. */
async function mappingsWithSnapshotToday(mappingIds: string[], dayStart: string): Promise<Set<string>> {
  if (mappingIds.length === 0) return new Set();
  const { data, error } = await db
    .from('price_snapshots')
    .select('supermarket_product_id')
    .in('supermarket_product_id', mappingIds)
    .gte('scraped_at', dayStart);
  if (error) throw error;
  return new Set((data ?? []).map((r) => r.supermarket_product_id as string));
}

export interface PhantomMarkerResult {
  candidates: number;
  emitted: number;
  skipped: number;
}

/**
 * Emit today's run-less `not_found` marker for every active phantom mapping
 * that doesn't already have a snapshot today. Safe to call multiple times a day.
 */
export async function emitPhantomMarkers(): Promise<PhantomMarkerResult> {
  const mappingIds = await loadActivePhantomMappings();
  if (mappingIds.length === 0) return { candidates: 0, emitted: 0, skipped: 0 };

  const nowIso = new Date().toISOString();
  const dayStart = startOfUtcDay(new Date());
  const alreadyDone = await mappingsWithSnapshotToday(mappingIds, dayStart);
  const todo = mappingIds.filter((id) => !alreadyDone.has(id));

  if (todo.length > 0) {
    const rows = todo.map((id) => ({
      supermarket_product_id: id,
      scrape_run_id: null,
      scraped_at: nowIso,
      price: null,
      list_price: null,
      unit_price: null,
      unit_price_per: null,
      in_stock: false,
      currency: 'ARS',
      tier_used: 'phantom',
      status: 'not_found',
      promotions: [],
      raw_data: { source: PHANTOM_SOURCE },
    }));
    const { error } = await db.from('price_snapshots').insert(rows);
    if (error) throw error;
  }

  const result: PhantomMarkerResult = {
    candidates: mappingIds.length,
    emitted: todo.length,
    skipped: mappingIds.length - todo.length,
  };
  logger.info(result, 'phantom markers emitted');
  return result;
}
