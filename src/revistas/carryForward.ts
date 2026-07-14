/**
 * Revista price carry-forward.
 *
 * Magazine ("revista") chains don't have a scraper adapter — their prices only
 * enter the system when a human approves a reviewed magazine item, which writes
 * ONE `price_snapshots` row on approval day. The daily scrape re-snapshots every
 * *regular* product every day, but a magazine product would otherwise have no
 * snapshot on the days between issues — so it would drop out of the daily client
 * export the day after approval.
 *
 * This step fixes that: once per day it re-emits each active revista product's
 * latest known price as a fresh snapshot dated today (tied to the day's run, so
 * it publishes through the normal gate). Semantics: **carry each product's
 * latest approved price forward until a newer approved price replaces it** (the
 * `carry_latest` policy). A new issue's approvals simply become the new latest
 * price and carry forward from then; products dropped from a new issue keep
 * their last price until re-approved.
 *
 * Idempotent per day: a product that already has a snapshot dated today (either
 * approved today, or already carried today) is skipped, so re-running is safe
 * and a same-day approval is never duplicated.
 */

import { db } from '../shared/db.js';
import { logger } from '../shared/logger.js';

/** YYYY-MM-DD for a date in Argentina time (the business day the export uses). */
function buenosAiresDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
  }).format(d);
}

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

/** The subset of a snapshot we copy forward. */
interface CarrySnapshot {
  id: number;
  price: number | null;
  list_price: number | null;
  unit_price: number | null;
  unit_price_per: string | null;
  offer_price_1: number | null;
  offer_price_2: number | null;
  promotion_1: string | null;
  promotion_2: string | null;
  unit_discount: number | null;
  promotions: unknown;
  in_stock: boolean | null;
  currency: string | null;
  site_product_name: string | null;
  scraped_at: string;
}

const SNAPSHOT_COLS =
  'id, price, list_price, unit_price, unit_price_per, offer_price_1, offer_price_2, ' +
  'promotion_1, promotion_2, unit_discount, promotions, in_stock, currency, site_product_name, scraped_at';

export interface CarryForwardResult {
  supermarkets: number;
  productsConsidered: number;
  carried: number;
  skippedAlreadyToday: number;
  skippedNoPrice: number;
}

/**
 * Re-emit the latest known price for every active revista product as a fresh
 * snapshot dated today, tied to `scrapeRunId` (nullable — a run-less snapshot is
 * always client-visible, handy for manual backfills).
 */
export async function carryForwardRevistaPrices(
  scrapeRunId: string | null,
): Promise<CarryForwardResult> {
  const log = logger.child({ phase: 'revista-carry-forward', scrapeRunId });
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

  const today = buenosAiresDate(new Date());

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

      // Latest snapshot for this product (the price we carry forward).
      const snapRes = await db
        .from('price_snapshots')
        .select(SNAPSHOT_COLS)
        .eq('supermarket_product_id', productId)
        .order('scraped_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (snapRes.error) throw snapRes.error;
      const snap = snapRes.data as CarrySnapshot | null;

      // No usable price yet (never approved, or a price-less marker) → nothing
      // to carry. Once the operator approves an item this fills in.
      if (!snap || snap.price == null) {
        result.skippedNoPrice++;
        continue;
      }

      // Already has a snapshot dated today (approved today, or carried earlier
      // today) → don't duplicate.
      if (buenosAiresDate(new Date(snap.scraped_at)) === today) {
        result.skippedAlreadyToday++;
        continue;
      }

      const insErr = (
        await db.from('price_snapshots').insert({
          supermarket_product_id: productId,
          scrape_run_id: scrapeRunId,
          scraped_at: new Date().toISOString(),
          price: snap.price,
          list_price: snap.list_price,
          unit_price: snap.unit_price,
          unit_price_per: snap.unit_price_per,
          offer_price_1: snap.offer_price_1,
          offer_price_2: snap.offer_price_2,
          promotion_1: snap.promotion_1,
          promotion_2: snap.promotion_2,
          unit_discount: snap.unit_discount,
          promotions: snap.promotions ?? [],
          in_stock: snap.in_stock ?? true,
          currency: snap.currency ?? 'ARS',
          tier_used: 'ai',
          status: 'ok',
          raw_data: { source: 'revista-carry-forward', from_snapshot_id: snap.id },
          site_product_name: snap.site_product_name,
        })
      ).error;
      if (insErr) throw insErr;
      result.carried++;
    }
  }

  log.info(result, 'revista carry-forward complete');
  return result;
}
