/**
 * Revista price carry-forward.
 *
 * Magazine chains don't have a scraper adapter — their prices only enter when
 * a human approves a reviewed magazine item. This step re-emits each product
 * approved on every **current** (non-superseded) magazine — one per flyer
 * SERIES — as a fresh RUN-LESS snapshot dated today, via the shared
 * idempotent writer.
 *
 * When a newer magazine B supersedes A within the same series, carry-forward
 * of A's prices stops until items on B are approved. Concurrent series
 * (Makro MM vs GT, Vital Folder vs Nonfood) keep emitting independently.
 * See docs/REVISTA_REVIEW.md.
 */

import { db } from '../shared/db.js';
import { logger } from '../shared/logger.js';
import { buenosAiresDate } from './pricing.js';
import { ensureTodayRevistaSnapshot } from './approve.js';
import { getCurrentMagazineIds } from './store.js';

/** Active supermarket ids flagged as magazine-sourced (config.source_type='revista'). */
async function activeRevistaSupermarketIds(): Promise<string[]> {
  const { data, error } = await db
    .from('supermarkets')
    .select('id, config')
    .eq('is_active', true);
  if (error) throw error;
  return (data ?? [])
    .filter(
      (s) => (s.config as { source_type?: string } | null)?.source_type === 'revista',
    )
    .map((s) => s.id as string);
}

interface CarrySnapshot {
  id: number;
  price: number | null;
  list_price: number | null;
  offer_price_1: number | null;
  promotion_1: string | null;
  promotions: unknown;
  site_product_name: string | null;
  scraped_at: string;
}

const SNAPSHOT_COLS =
  'id, price, list_price, offer_price_1, promotion_1, promotions, site_product_name, scraped_at';

export interface CarryForwardResult {
  supermarkets: number;
  magazines: number;
  productsConsidered: number;
  carried: number;
  skippedAlreadyToday: number;
  skippedNoPrice: number;
  skippedNoCurrentMagazine: number;
}

/**
 * Re-emit the latest known price for every product approved on every current
 * magazine (one per series) of each revista chain as today's run-less snapshot.
 */
export async function carryForwardRevistaPrices(): Promise<CarryForwardResult> {
  const log = logger.child({ phase: 'revista-carry-forward' });
  const smIds = await activeRevistaSupermarketIds();
  const result: CarryForwardResult = {
    supermarkets: smIds.length,
    magazines: 0,
    productsConsidered: 0,
    carried: 0,
    skippedAlreadyToday: 0,
    skippedNoPrice: 0,
    skippedNoCurrentMagazine: 0,
  };
  if (smIds.length === 0) {
    log.debug('no active revista supermarkets — nothing to carry forward');
    return result;
  }

  const today = buenosAiresDate();

  for (const smId of smIds) {
    const currentMagazineIds = await getCurrentMagazineIds(smId);
    if (currentMagazineIds.length === 0) {
      result.skippedNoCurrentMagazine++;
      continue;
    }
    result.magazines += currentMagazineIds.length;

    // Only mappings with an approved review item on a CURRENT magazine
    // (any active series for this chain).
    const itemsRes = await db
      .from('revista_review_items')
      .select('resulting_supermarket_product_id')
      .in('magazine_id', currentMagazineIds)
      .eq('status', 'approved')
      .not('resulting_supermarket_product_id', 'is', null);
    if (itemsRes.error) throw itemsRes.error;

    const productIds = [
      ...new Set(
        (itemsRes.data ?? [])
          .map((r) => r.resulting_supermarket_product_id as string | null)
          .filter((id): id is string => Boolean(id)),
      ),
    ];

    for (const productId of productIds) {
      // Skip paused mappings (e.g. undone approvals).
      const spRes = await db
        .from('supermarket_products')
        .select('id, is_active')
        .eq('id', productId)
        .maybeSingle();
      if (spRes.error) throw spRes.error;
      if (!spRes.data || spRes.data.is_active === false) continue;

      result.productsConsidered++;

      const snapRes = await db
        .from('price_snapshots')
        .select(SNAPSHOT_COLS)
        .eq('supermarket_product_id', productId)
        .order('scraped_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (snapRes.error) throw snapRes.error;
      const snap = snapRes.data as CarrySnapshot | null;

      if (!snap || snap.price == null) {
        result.skippedNoPrice++;
        continue;
      }

      const snapDay = buenosAiresDate(new Date(snap.scraped_at));
      if (snapDay === today) {
        result.skippedAlreadyToday++;
        continue;
      }

      // Re-emit via the shared writer so we never create a second row for today
      // if something else wrote one between the check and the insert.
      await ensureTodayRevistaSnapshot({
        supermarketProductId: productId,
        prices: {
          price: snap.list_price ?? snap.price,
          promoPrice: snap.offer_price_1,
          promoText: snap.promotion_1,
        },
        siteProductName: snap.site_product_name,
        tierUsed: 'ai',
        rawSource: 'revista-carry-forward',
        fromSnapshotId: snap.id,
      });
      result.carried++;
    }
  }

  log.info(result, 'revista carry-forward complete');
  return result;
}
