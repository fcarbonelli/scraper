/**
 * Revista price carry-forward.
 *
 * Magazine chains don't have a scraper adapter — their prices only enter when
 * a human approves a reviewed magazine item. This step re-emits each active
 * revista product's latest known price as a fresh RUN-LESS snapshot dated
 * today, via the shared idempotent writer (update-in-place if today already
 * has a row). See docs/REVISTA_REVIEW.md.
 */

import { db } from '../shared/db.js';
import { logger } from '../shared/logger.js';
import { buenosAiresDate } from './pricing.js';
import { ensureTodayRevistaSnapshot } from './approve.js';

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
  productsConsidered: number;
  carried: number;
  skippedAlreadyToday: number;
  skippedNoPrice: number;
}

/**
 * Re-emit the latest known price for every active revista product as today's
 * run-less snapshot (idempotent via ensureTodayRevistaSnapshot).
 */
export async function carryForwardRevistaPrices(): Promise<CarryForwardResult> {
  const log = logger.child({ phase: 'revista-carry-forward' });
  const smIds = await activeRevistaSupermarketIds();
  const result: CarryForwardResult = {
    supermarkets: smIds.length,
    productsConsidered: 0,
    carried: 0,
    skippedAlreadyToday: 0,
    skippedNoPrice: 0,
  };
  if (smIds.length === 0) {
    log.debug('no active revista supermarkets — nothing to carry forward');
    return result;
  }

  const today = buenosAiresDate();

  for (const smId of smIds) {
    const productsRes = await db
      .from('supermarket_products')
      .select('id')
      .eq('supermarket_id', smId)
      .eq('is_active', true);
    if (productsRes.error) throw productsRes.error;

    for (const p of productsRes.data ?? []) {
      result.productsConsidered++;
      const productId = p.id as string;

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
