/**
 * Turning a reviewed magazine item into real price data.
 *
 * Approving (or manually adding) an item:
 *   1. ensures a `supermarket_products` mapping for (supermarket, product),
 *   2. writes ONE `price_snapshots` row (`tier_used:'ai'`, `status:'ok'`) tied
 *      to the magazine's run, so it flows through the normal publish gate,
 *   3. stamps the review item with the result.
 *
 * Catalog-only: `product_id` must reference an existing master product. There's
 * no "create a new master product" path here (see docs/REVISTA_REVIEW.md §3).
 */

import { db } from '../shared/db.js';
import { logger } from '../shared/logger.js';

/** Synthetic SKU for a revista-sourced mapping (no real site SKU exists). */
function revistaExternalId(productId: string): string {
  return `revista-${productId}`;
}

/**
 * Find-or-create the supermarket_products mapping for a revista product.
 * Idempotent via the synthetic external_id + UNIQUE(supermarket_id, external_id).
 */
async function ensureSupermarketProduct(
  supermarketId: string,
  productId: string,
  magazineId: string,
): Promise<string> {
  const externalId = revistaExternalId(productId);

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
      metadata: { source: 'revista', magazine_id: magazineId },
    })
    .select('id')
    .single();
  if (inserted.error) throw inserted.error;
  return inserted.data.id as string;
}

export interface SnapshotPrices {
  /** Regular price the reviewer confirms off the image. */
  price: number | null;
  /** Sale/offer price, if any. */
  promoPrice: number | null;
  /** Promo text (e.g. "2x1", "2do al 50%"). */
  promoText: string | null;
}

/**
 * Write one price snapshot for an approved revista item.
 *
 * Price semantics follow the platform convention: `price` = the selling price
 * (the promo price when there's an offer), `list_price` = the regular crossed-
 * out price when marked down, and the promo text becomes Promocion_1.
 */
async function writeSnapshot(
  supermarketProductId: string,
  scrapeRunId: string | null,
  prices: SnapshotPrices,
  siteProductName: string | null,
): Promise<number> {
  const hasPromo = prices.promoPrice != null && prices.promoPrice > 0;
  const regular = prices.price ?? prices.promoPrice ?? null;
  const selling = hasPromo ? (prices.promoPrice as number) : regular;
  if (selling == null) {
    throw new Error('Cannot write a snapshot without a price or promo price.');
  }
  // list_price = regular only when it's a genuine markdown above the selling price.
  const listPrice = hasPromo && regular != null && regular > selling ? regular : null;

  const promotions = prices.promoText
    ? [{ type: 'unknown', description: prices.promoText }]
    : [];

  const { data, error } = await db
    .from('price_snapshots')
    .insert({
      supermarket_product_id: supermarketProductId,
      scrape_run_id: scrapeRunId,
      scraped_at: new Date().toISOString(),
      price: selling,
      list_price: listPrice,
      in_stock: true,
      currency: 'ARS',
      tier_used: 'ai',
      status: 'ok',
      promotions,
      promotion_1: prices.promoText ?? null,
      offer_price_1: hasPromo ? (prices.promoPrice as number) : null,
      raw_data: { source: 'revista' },
      site_product_name: siteProductName,
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as number;
}

// =============================================================================
// Review-item rows we read
// =============================================================================
interface ReviewItemRow {
  id: string;
  magazine_id: string;
  supermarket_id: string;
  status: 'pending' | 'approved' | 'rejected';
  proposed_product_id: string | null;
  method: string;
  extracted: {
    name?: string | null;
    price?: number | null;
    promo_price?: number | null;
    promo_text?: string | null;
  } | null;
}

export interface ApproveBody {
  productId?: string;
  price?: number;
  promoPrice?: number;
  promoText?: string;
  note?: string;
  reviewedBy?: string;
}

export interface ApproveResult {
  itemId: string;
  status: 'approved';
  supermarketProductId: string;
  snapshotId: number;
  productId: string;
}

/** Resolve the run a magazine's snapshots attach to. */
async function magazineRunId(magazineId: string): Promise<string | null> {
  const { data, error } = await db
    .from('revista_magazines')
    .select('scrape_run_id')
    .eq('id', magazineId)
    .maybeSingle();
  if (error) throw error;
  return (data?.scrape_run_id as string | null) ?? null;
}

/**
 * Approve a queued review item → mapping + snapshot. Throws on conflict
 * (already reviewed) / missing match; the route maps these to HTTP codes.
 */
export async function approveReviewItem(
  itemId: string,
  body: ApproveBody,
): Promise<ApproveResult> {
  const { data, error } = await db
    .from('revista_review_items')
    .select('id, magazine_id, supermarket_id, status, proposed_product_id, method, extracted')
    .eq('id', itemId)
    .maybeSingle();
  if (error) throw error;
  const item = data as ReviewItemRow | null;
  if (!item) throw new ItemError('not_found', 'Review item not found');
  if (item.status !== 'pending') {
    throw new ItemError('conflict', `Item already ${item.status}`);
  }

  const productId = body.productId ?? item.proposed_product_id;
  if (!productId) {
    throw new ItemError('invalid', 'No product to approve: provide product_id (no proposed match).');
  }

  const prices: SnapshotPrices = {
    price: body.price ?? item.extracted?.price ?? null,
    promoPrice: body.promoPrice ?? item.extracted?.promo_price ?? null,
    promoText: body.promoText ?? item.extracted?.promo_text ?? null,
  };
  if (prices.price == null && prices.promoPrice == null) {
    throw new ItemError('invalid', 'No price to record (neither price nor promo_price).');
  }

  const spId = await ensureSupermarketProduct(item.supermarket_id, productId, item.magazine_id);
  const runId = await magazineRunId(item.magazine_id);
  const snapshotId = await writeSnapshot(spId, runId, prices, item.extracted?.name ?? null);

  const upd = await db
    .from('revista_review_items')
    .update({
      status: 'approved',
      proposed_product_id: productId,
      note: body.note ?? null,
      reviewed_by: body.reviewedBy ?? null,
      reviewed_at: new Date().toISOString(),
      resulting_supermarket_product_id: spId,
      resulting_snapshot_id: snapshotId,
    })
    .eq('id', itemId);
  if (upd.error) throw upd.error;

  logger.info({ itemId, productId, spId, snapshotId }, 'revista: item approved');
  return { itemId, status: 'approved', supermarketProductId: spId, snapshotId, productId };
}

export interface ManualAddBody {
  pageNumber: number;
  productId: string;
  price: number;
  promoPrice?: number;
  promoText?: string;
  note?: string;
  reviewedBy?: string;
}

/** Manually add a product the AI missed: creates an approved manual item + snapshot. */
export async function addManualItem(
  magazineId: string,
  supermarketId: string,
  pageImageUrl: string | null,
  body: ManualAddBody,
): Promise<ApproveResult> {
  const prices: SnapshotPrices = {
    price: body.price,
    promoPrice: body.promoPrice ?? null,
    promoText: body.promoText ?? null,
  };

  const spId = await ensureSupermarketProduct(supermarketId, body.productId, magazineId);
  const runId = await magazineRunId(magazineId);
  const snapshotId = await writeSnapshot(spId, runId, prices, null);

  const { data, error } = await db
    .from('revista_review_items')
    .insert({
      magazine_id: magazineId,
      supermarket_id: supermarketId,
      page_number: body.pageNumber,
      page_image_url: pageImageUrl,
      extracted: {
        name: null,
        brand: null,
        ean: null,
        price: body.price,
        promo_price: body.promoPrice ?? null,
        promo_text: body.promoText ?? null,
        quantity: null,
      },
      proposed_product_id: body.productId,
      confidence: 1,
      method: 'manual',
      reason: 'Agregado manualmente por el revisor',
      candidates: [],
      status: 'approved',
      note: body.note ?? null,
      reviewed_by: body.reviewedBy ?? null,
      reviewed_at: new Date().toISOString(),
      resulting_supermarket_product_id: spId,
      resulting_snapshot_id: snapshotId,
    })
    .select('id')
    .single();
  if (error) throw error;

  logger.info({ magazineId, itemId: data.id, productId: body.productId, snapshotId }, 'revista: manual item added');
  return {
    itemId: data.id as string,
    status: 'approved',
    supermarketProductId: spId,
    snapshotId,
    productId: body.productId,
  };
}

/** Domain error with a coarse kind the route maps to an HTTP status. */
export class ItemError extends Error {
  readonly kind: 'not_found' | 'conflict' | 'invalid';
  constructor(kind: 'not_found' | 'conflict' | 'invalid', message: string) {
    super(message);
    this.name = 'ItemError';
    this.kind = kind;
  }
}
