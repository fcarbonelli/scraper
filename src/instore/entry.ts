/**
 * Record an in-store price entry.
 *
 * A field worker, physically in the store, scans a barcode and types the shelf
 * price. That submission:
 *   1. resolves the EAN to a master product (creating one from catalog if
 *      needed — see resolve.ts),
 *   2. ensures a `supermarket_products` mapping for (store, product),
 *   3. writes ONE run-less `price_snapshots` row (trusted, always
 *      client-visible; carried forward daily until superseded),
 *   4. logs the submission to `instore_price_entries` for attribution/review.
 *
 * The operator on-site is the gate, so snapshots are RUN-LESS (scrape_run_id =
 * null) exactly like the revista and manual-snapshot paths.
 */

import { db } from '../shared/db.js';
import { logger } from '../shared/logger.js';
import { ensureMasterProductForEan } from './resolve.js';

/** Synthetic SKU for an in-store mapping (no real site SKU exists). */
export function inStoreExternalId(productId: string): string {
  return `instore-${productId}`;
}

/** Marks mappings/snapshots created by the in-store tool (used by enqueue + carry-forward). */
export const IN_STORE_SOURCE = 'instore';

export interface InStoreEntryInput {
  supermarketId: string;
  ean: string;
  /** Regular / shelf price the operator sees. */
  price: number;
  /** Sale/offer price, when there's a promotion. */
  promoPrice?: number | null;
  /** Free-text promo description (e.g. "2x1", "-30%"). */
  promoText?: string | null;
  /** Field worker's name (saved in their browser, required). */
  enteredBy: string;
  note?: string | null;
  /** The API key that submitted (for the audit log). */
  apiKeyId?: string | null;
}

export interface InStoreEntryResult {
  entryId: string;
  supermarketId: string;
  ean: string;
  productId: string;
  supermarketProductId: string;
  snapshotId: number;
  price: number;
  listPrice: number | null;
  promoPrice: number | null;
  promoText: string | null;
  enteredBy: string;
  createdAt: string;
}

/**
 * Find-or-create the in-store mapping for (supermarket, product). Idempotent via
 * the synthetic external_id + UNIQUE(supermarket_id, external_id): repeated
 * visits reuse the mapping and just append new snapshots.
 */
async function ensureInStoreMapping(
  supermarketId: string,
  productId: string,
): Promise<string> {
  const externalId = inStoreExternalId(productId);

  const existing = await db
    .from('supermarket_products')
    .select('id')
    .eq('supermarket_id', supermarketId)
    .eq('external_id', externalId)
    .maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data) return existing.data.id as string;

  const inserted = await db
    .from('supermarket_products')
    .insert({
      supermarket_id: supermarketId,
      product_id: productId,
      external_id: externalId,
      external_url: null,
      is_active: true,
      metadata: { source: IN_STORE_SOURCE },
    })
    .select('id')
    .single();
  if (inserted.error) throw inserted.error;
  return inserted.data.id as string;
}

interface SnapshotPrices {
  price: number;
  promoPrice: number | null;
  promoText: string | null;
}

/**
 * Write one run-less snapshot for an in-store entry. Price semantics match the
 * platform convention (also used by revista): `price` = the selling price (the
 * promo price when there's an offer), `list_price` = the regular crossed-out
 * price when marked down, promo text → Promocion_1.
 */
async function writeSnapshot(
  supermarketProductId: string,
  prices: SnapshotPrices,
  meta: { enteredBy: string; ean: string; apiKeyId: string | null; note: string | null },
): Promise<{ snapshotId: number; listPrice: number | null }> {
  const hasPromo = prices.promoPrice != null && prices.promoPrice > 0;
  const regular = prices.price;
  const selling = hasPromo ? (prices.promoPrice as number) : regular;
  const listPrice = hasPromo && regular > selling ? regular : null;

  const promotions = prices.promoText
    ? [{ type: 'unknown', description: prices.promoText }]
    : [];

  const { data, error } = await db
    .from('price_snapshots')
    .insert({
      supermarket_product_id: supermarketProductId,
      // Run-less: operator-trusted, always client-visible, no publish gate.
      scrape_run_id: null,
      scraped_at: new Date().toISOString(),
      price: selling,
      list_price: listPrice,
      in_stock: true,
      currency: 'ARS',
      tier_used: 'manual',
      status: 'ok',
      promotions,
      promotion_1: prices.promoText ?? null,
      offer_price_1: hasPromo ? (prices.promoPrice as number) : null,
      raw_data: {
        source: IN_STORE_SOURCE,
        entered_by: meta.enteredBy,
        ean: meta.ean,
        api_key_id: meta.apiKeyId,
        note: meta.note,
      },
    })
    .select('id')
    .single();
  if (error) throw error;
  return { snapshotId: data.id as number, listPrice };
}

/** Domain error with a coarse kind the route maps to an HTTP status. */
export class InStoreError extends Error {
  readonly kind: 'not_found' | 'invalid';
  constructor(kind: 'not_found' | 'invalid', message: string) {
    super(message);
    this.name = 'InStoreError';
    this.kind = kind;
  }
}

/** Ensure the supermarket exists, is active, and is flagged for in-store entry. */
async function assertInStoreSupermarket(supermarketId: string): Promise<void> {
  const { data, error } = await db
    .from('supermarkets')
    .select('id, is_active, config')
    .eq('id', supermarketId)
    .maybeSingle();
  if (error) throw error;
  if (!data || !data.is_active) {
    throw new InStoreError('not_found', `Supermarket "${supermarketId}" not found or inactive`);
  }
  const cfg = data.config as { instore?: { enabled?: boolean } } | null;
  if (!cfg?.instore?.enabled) {
    throw new InStoreError('invalid', `Supermarket "${supermarketId}" is not enabled for in-store entry`);
  }
}

/**
 * Record one in-store price submission end to end. Throws InStoreError for
 * caller mistakes (unknown store, EAN not in catalog); the route maps those to
 * HTTP status codes.
 */
export async function recordInStoreEntry(
  input: InStoreEntryInput,
): Promise<InStoreEntryResult> {
  await assertInStoreSupermarket(input.supermarketId);

  const productId = await ensureMasterProductForEan(input.ean);
  if (!productId) {
    throw new InStoreError(
      'not_found',
      `EAN ${input.ean} is not in the catalog`,
    );
  }

  const spId = await ensureInStoreMapping(input.supermarketId, productId);

  const prices: SnapshotPrices = {
    price: input.price,
    promoPrice: input.promoPrice ?? null,
    promoText: input.promoText ?? null,
  };
  const { snapshotId, listPrice } = await writeSnapshot(spId, prices, {
    enteredBy: input.enteredBy,
    ean: input.ean,
    apiKeyId: input.apiKeyId ?? null,
    note: input.note ?? null,
  });

  const entryInsert = await db
    .from('instore_price_entries')
    .insert({
      supermarket_id: input.supermarketId,
      ean: input.ean,
      product_id: productId,
      resulting_supermarket_product_id: spId,
      resulting_snapshot_id: snapshotId,
      price: input.price,
      list_price: listPrice,
      promo_price: input.promoPrice ?? null,
      promo_text: input.promoText ?? null,
      entered_by: input.enteredBy,
      api_key_id: input.apiKeyId ?? null,
      note: input.note ?? null,
    })
    .select('id, created_at')
    .single();
  if (entryInsert.error) throw entryInsert.error;

  logger.info(
    { supermarketId: input.supermarketId, ean: input.ean, productId, spId, snapshotId, enteredBy: input.enteredBy },
    'instore: price entry recorded',
  );

  return {
    entryId: entryInsert.data.id as string,
    supermarketId: input.supermarketId,
    ean: input.ean,
    productId,
    supermarketProductId: spId,
    snapshotId,
    price: input.price,
    listPrice,
    promoPrice: input.promoPrice ?? null,
    promoText: input.promoText ?? null,
    enteredBy: input.enteredBy,
    createdAt: entryInsert.data.created_at as string,
  };
}
