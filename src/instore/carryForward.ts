/**
 * In-store price carry-forward.
 *
 * In-store prices are entered by hand only every few days (a worker visits the
 * store twice a week or so). Without this step, a product priced on Monday
 * would drop out of the daily client export on Tuesday. So — exactly like the
 * revista carry-forward — once per day we re-emit each in-store mapping's latest
 * known price as a fresh RUN-LESS snapshot dated today. Run-less means always
 * client-visible, independent of any daily run's publish gate.
 *
 * Policy: **carry each product's latest in-store price forward until a newer
 * entry replaces it.** A new visit's submissions simply become the new latest
 * price and carry forward from then.
 *
 * Scope is per-MAPPING, not per-chain: we carry every mapping tagged
 * metadata.source='instore' regardless of the supermarket's source_type. That
 * way a web-scraped chain (e.g. Maxiconsumo) or a revista chain (Makro/Vital)
 * can ALSO collect in-store prices — the web/revista mappings are untouched;
 * only the in-store mappings are carried here.
 *
 * Idempotent per day: a mapping that already has a snapshot dated today (entered
 * today, or already carried) is skipped, so re-running is safe.
 */

import { db } from '../shared/db.js';
import { logger } from '../shared/logger.js';
import { IN_STORE_SOURCE } from './entry.js';

/** YYYY-MM-DD for a date in Argentina time (the business day the export uses). */
function buenosAiresDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
  }).format(d);
}

/** Active supermarket ids flagged for in-store entry (config.instore.enabled). */
async function activeInStoreSupermarketIds(): Promise<string[]> {
  const { data, error } = await db
    .from('supermarkets')
    .select('id, config')
    .eq('is_active', true);
  if (error) throw error;
  return (data ?? [])
    .filter(
      (s) =>
        (s.config as { instore?: { enabled?: boolean } } | null)?.instore
          ?.enabled === true,
    )
    .map((s) => s.id as string);
}

/** The subset of a snapshot we copy forward. */
interface CarrySnapshot {
  id: number;
  price: number | null;
  list_price: number | null;
  offer_price_1: number | null;
  promotion_1: string | null;
  promotions: unknown;
  in_stock: boolean | null;
  currency: string | null;
  site_product_name: string | null;
  scraped_at: string;
}

const SNAPSHOT_COLS =
  'id, price, list_price, offer_price_1, promotion_1, promotions, in_stock, currency, site_product_name, scraped_at';

export interface CarryForwardResult {
  supermarkets: number;
  productsConsidered: number;
  carried: number;
  skippedAlreadyToday: number;
  skippedNoPrice: number;
}

/**
 * Re-emit the latest known price for every active in-store mapping as a fresh
 * run-less snapshot dated today.
 */
export async function carryForwardInStorePrices(): Promise<CarryForwardResult> {
  const log = logger.child({ phase: 'instore-carry-forward' });
  const smIds = await activeInStoreSupermarketIds();
  const result: CarryForwardResult = {
    supermarkets: smIds.length,
    productsConsidered: 0,
    carried: 0,
    skippedAlreadyToday: 0,
    skippedNoPrice: 0,
  };
  if (smIds.length === 0) {
    log.debug('no active in-store supermarkets — nothing to carry forward');
    return result;
  }

  const today = buenosAiresDate(new Date());

  for (const smId of smIds) {
    // Only in-store mappings — leaves any web/revista mappings on the same
    // chain untouched (those are carried/scraped by their own pipelines).
    const productsRes = await db
      .from('supermarket_products')
      .select('id')
      .eq('supermarket_id', smId)
      .eq('is_active', true)
      .eq('metadata->>source', IN_STORE_SOURCE);
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

      // Already has a snapshot dated today (entered today, or carried earlier).
      if (buenosAiresDate(new Date(snap.scraped_at)) === today) {
        result.skippedAlreadyToday++;
        continue;
      }

      const insErr = (
        await db.from('price_snapshots').insert({
          supermarket_product_id: productId,
          scrape_run_id: null,
          scraped_at: new Date().toISOString(),
          price: snap.price,
          list_price: snap.list_price,
          offer_price_1: snap.offer_price_1,
          promotion_1: snap.promotion_1,
          promotions: snap.promotions ?? [],
          in_stock: snap.in_stock ?? true,
          currency: snap.currency ?? 'ARS',
          tier_used: 'manual',
          status: 'ok',
          raw_data: { source: 'instore-carry-forward', from_snapshot_id: snap.id },
          site_product_name: snap.site_product_name,
        })
      ).error;
      if (insErr) throw insErr;
      result.carried++;
    }
  }

  log.info(result, 'instore carry-forward complete');
  return result;
}
