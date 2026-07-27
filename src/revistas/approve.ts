/**
 * Turning a reviewed magazine item into real price data.
 *
 * Approving / editing / manually adding an item:
 *   1. ensures a `supermarket_products` mapping for (supermarket, product),
 *   2. ensures ONE run-less `price_snapshots` row for TODAY (insert or
 *      update-in-place — never a second row the same BA day),
 *   3. stamps the review item with the result.
 *
 * Snapshots are written RUN-LESS (`scrape_run_id = null`). A human approving
 * the item in the revista review IS the gate — so these are trusted and always
 * client-visible. Carry-forward re-emits them daily until the next issue.
 *
 * Catalog-only: `product_id` must reference an existing master product whose
 * EAN is in the official Catálogo EAN (TAXONOMY ∪ catalog_extra_eans). Matching
 * may still propose any master; approve/manual-add/rematch enforce the gate.
 */

import { db } from '../shared/db.js';
import { logger } from '../shared/logger.js';
import { lookupCatalog } from '../shared/catalog.js';
import type { TaxonomyEntry } from '../shared/taxonomy.js';
import { deleteMagazineImages } from './storage.js';
import {
  buenosAiresDate,
  decideTodayWrite,
  mapSnapshotPrices,
  type SnapshotPrices,
} from './pricing.js';

export type { SnapshotPrices } from './pricing.js';

/** Synthetic SKU for a revista-sourced mapping (no real site SKU exists). */
export function revistaExternalId(productId: string): string {
  return `revista-${productId}`;
}

/** Taxonomy columns mirrored onto `products` for the client export. */
function taxonomyPatch(tax: TaxonomyEntry): Record<string, unknown> {
  return {
    category: tax.category || null,
    subcategory: tax.subcategory || null,
    manufacturer: tax.manufacturer || null,
    brand: tax.brand || null,
    format: tax.format || null,
    variety: tax.variety || null,
    description_forms: tax.descriptionForms || null,
  };
}

/**
 * Require that `productId` has an EAN present in the official Catálogo EAN.
 * When it does, backfill taxonomy onto the master so the exportable is complete.
 */
export async function assertProductInEanCatalog(
  productId: string,
): Promise<{ ean: string }> {
  const { data, error } = await db
    .from('products')
    .select(
      'id, ean, category, subcategory, manufacturer, brand, format, variety, description_forms',
    )
    .eq('id', productId)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new ItemError('invalid', `Producto ${productId} no existe en el catálogo de productos.`);
  }

  const ean = typeof data.ean === 'string' ? data.ean.replace(/\D/g, '') : '';
  if (!ean) {
    throw new ItemError(
      'invalid',
      'El producto no tiene EAN; no se puede aprobar. Asignale un EAN que exista en el Catálogo EAN.',
    );
  }

  const tax = await lookupCatalog(ean);
  if (!tax) {
    throw new ItemError(
      'invalid',
      `EAN ${ean} no está en el Catálogo EAN. Agregalo ahí antes de aprobar.`,
    );
  }

  // Fill blank taxonomy so client_base / export get full columns.
  const needsEnrich =
    !data.category ||
    !data.description_forms ||
    !data.brand ||
    !data.manufacturer ||
    !data.subcategory ||
    !data.format;

  if (needsEnrich) {
    const patch = taxonomyPatch(tax);
    const upd = await db.from('products').update(patch).eq('id', productId);
    if (upd.error) throw upd.error;
    logger.info({ productId, ean }, 'revista: enriched product taxonomy from Catálogo EAN');
  }

  return { ean };
}

/**
 * Block writes (approve / edit / manual add) on a manually deactivated magazine.
 * A deactivated issue is off the client base on purpose; approving into it would
 * silently re-activate its mapping. Reactivate the magazine first.
 */
async function assertMagazineCarryActive(magazineId: string): Promise<void> {
  const { data, error } = await db
    .from('revista_magazines')
    .select('carry_active')
    .eq('id', magazineId)
    .maybeSingle();
  if (error) throw error;
  if (data && data.carry_active === false) {
    throw new ItemError(
      'conflict',
      'La revista está desactivada. Reactivala antes de aprobar o editar sus productos.',
    );
  }
}

/**
 * Find-or-create the supermarket_products mapping for a revista product.
 * Idempotent via the synthetic external_id + UNIQUE(supermarket_id, external_id).
 */
export async function ensureSupermarketProduct(
  supermarketId: string,
  productId: string,
  magazineId: string,
): Promise<string> {
  const externalId = revistaExternalId(productId);

  const existing = await db
    .from('supermarket_products')
    .select('id, is_active')
    .eq('supermarket_id', supermarketId)
    .eq('external_id', externalId)
    .maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data) {
    // Re-activate if a prior undo paused this mapping (rematch / re-approve).
    if (existing.data.is_active === false) {
      const { error } = await db
        .from('supermarket_products')
        .update({ is_active: true, metadata: { source: 'revista', magazine_id: magazineId } })
        .eq('id', existing.data.id);
      if (error) throw error;
    }
    return existing.data.id as string;
  }

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

export interface EnsureTodaySnapshotArgs {
  supermarketProductId: string;
  prices: SnapshotPrices;
  siteProductName: string | null;
  /** 'ai' for vision approvals; 'manual' for rematch / manual add. */
  tierUsed?: 'ai' | 'manual';
  rawSource?: 'revista' | 'revista-carry-forward';
  /** When carrying forward, keep a pointer to the source snapshot. */
  fromSnapshotId?: number | null;
}

/**
 * Ensure exactly ONE run-less revista snapshot for this mapping on today's
 * Buenos Aires calendar day. Updates in-place if one already exists.
 */
export async function ensureTodayRevistaSnapshot(
  args: EnsureTodaySnapshotArgs,
): Promise<number> {
  const mapped = mapSnapshotPrices(args.prices);
  const today = buenosAiresDate();
  const tierUsed = args.tierUsed ?? 'ai';
  const rawSource = args.rawSource ?? 'revista';

  // Find an existing run-less revista snapshot dated today (BA).
  // Day is derived from scraped_at in JS so this works before migration 013
  // adds scraped_on (and stays correct after).
  let todayId: number | null = null;
  const recent = await db
    .from('price_snapshots')
    .select('id, scraped_at, raw_data')
    .eq('supermarket_product_id', args.supermarketProductId)
    .is('scrape_run_id', null)
    .order('scraped_at', { ascending: false })
    .limit(20);
  if (recent.error) throw recent.error;
  for (const row of recent.data ?? []) {
    const src = (row.raw_data as { source?: string } | null)?.source;
    if (src && src !== 'revista' && src !== 'revista-carry-forward') continue;
    if (buenosAiresDate(new Date(row.scraped_at as string)) === today) {
      todayId = row.id as number;
      break;
    }
  }

  const action = decideTodayWrite(todayId);
  const rawData: Record<string, unknown> = { source: rawSource };
  if (args.fromSnapshotId != null) rawData.from_snapshot_id = args.fromSnapshotId;

  // scraped_on is set when migration 013 is present; if the column is missing
  // Postgres will error — apply 013 before deploying this writer to prod.
  const columns: Record<string, unknown> = {
    price: mapped.price,
    list_price: mapped.list_price,
    in_stock: true,
    currency: 'ARS',
    tier_used: tierUsed,
    status: 'ok',
    promotions: mapped.promotions,
    promotion_1: mapped.promotion_1,
    offer_price_1: mapped.offer_price_1,
    raw_data: rawData,
    site_product_name: args.siteProductName,
    scraped_on: today,
  };

  if (action === 'update' && todayId != null) {
    const { error } = await db
      .from('price_snapshots')
      .update({
        ...columns,
        scraped_at: new Date().toISOString(),
      })
      .eq('id', todayId);
    if (error) {
      // Pre-migration 013: column scraped_on may not exist yet.
      if (String(error.message ?? '').includes('scraped_on')) {
        const { scraped_on: _drop, ...without } = columns;
        const retry = await db
          .from('price_snapshots')
          .update({ ...without, scraped_at: new Date().toISOString() })
          .eq('id', todayId);
        if (retry.error) throw retry.error;
        return todayId;
      }
      throw error;
    }
    return todayId;
  }

  const { data, error } = await db
    .from('price_snapshots')
    .insert({
      supermarket_product_id: args.supermarketProductId,
      scrape_run_id: null,
      scraped_at: new Date().toISOString(),
      ...columns,
    })
    .select('id')
    .single();
  if (error) {
    if (String(error.message ?? '').includes('scraped_on')) {
      const { scraped_on: _drop, ...without } = columns;
      const retry = await db
        .from('price_snapshots')
        .insert({
          supermarket_product_id: args.supermarketProductId,
          scrape_run_id: null,
          scraped_at: new Date().toISOString(),
          ...without,
        })
        .select('id')
        .single();
      if (retry.error) throw retry.error;
      return retry.data.id as number;
    }
    throw error;
  }
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
    brand?: string | null;
    ean?: string | null;
    price?: number | null;
    promo_price?: number | null;
    promo_text?: string | null;
    quantity?: string | null;
  } | null;
  /** Operator overrides — never overwrite `extracted` (AI read). */
  approved_override?: {
    price?: number | null;
    promo_price?: number | null;
    promo_text?: string | null;
  } | null;
  resulting_supermarket_product_id?: string | null;
  resulting_snapshot_id?: number | null;
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

/**
 * Approve a queued review item → mapping + today's snapshot. Throws on conflict
 * (already reviewed) / missing match; the route maps these to HTTP codes.
 */
export async function approveReviewItem(
  itemId: string,
  body: ApproveBody,
): Promise<ApproveResult> {
  const { data, error } = await db
    .from('revista_review_items')
    .select(
      'id, magazine_id, supermarket_id, status, proposed_product_id, method, extracted, approved_override, resulting_supermarket_product_id, resulting_snapshot_id',
    )
    .eq('id', itemId)
    .maybeSingle();
  if (error) throw error;
  const item = data as ReviewItemRow | null;
  if (!item) throw new ItemError('not_found', 'Review item not found');
  if (item.status !== 'pending') {
    throw new ItemError('conflict', `Item already ${item.status}`);
  }
  await assertMagazineCarryActive(item.magazine_id);

  const productId = body.productId ?? item.proposed_product_id;
  if (!productId) {
    throw new ItemError('invalid', 'No product to approve: provide product_id (no proposed match).');
  }

  await assertProductInEanCatalog(productId);

  const prices: SnapshotPrices = {
    price: body.price ?? item.extracted?.price ?? null,
    promoPrice: body.promoPrice ?? item.extracted?.promo_price ?? null,
    promoText: body.promoText ?? item.extracted?.promo_text ?? null,
  };
  if (prices.price == null && prices.promoPrice == null) {
    throw new ItemError('invalid', 'No price to record (neither price nor promo_price).');
  }

  const spId = await ensureSupermarketProduct(item.supermarket_id, productId, item.magazine_id);
  const snapshotId = await ensureTodayRevistaSnapshot({
    supermarketProductId: spId,
    prices,
    siteProductName: item.extracted?.name ?? null,
    tierUsed: body.productId && body.productId !== item.proposed_product_id ? 'manual' : 'ai',
  });

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
      ...(body.productId ? { method: 'manual' } : {}),
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
  await assertMagazineCarryActive(magazineId);

  await assertProductInEanCatalog(body.productId);

  const prices: SnapshotPrices = {
    price: body.price,
    promoPrice: body.promoPrice ?? null,
    promoText: body.promoText ?? null,
  };

  const spId = await ensureSupermarketProduct(supermarketId, body.productId, magazineId);
  const snapshotId = await ensureTodayRevistaSnapshot({
    supermarketProductId: spId,
    prices,
    siteProductName: null,
    tierUsed: 'manual',
  });

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

export interface UpdateApprovedBody {
  productId?: string;
  /** Regular price; omit to leave unchanged. Pass null to clear (not useful alone). */
  price?: number | null;
  /** Pass null to clear the promo price. */
  promoPrice?: number | null;
  /** Pass null or "" to clear. */
  promoText?: string | null;
  note?: string | null;
  reviewedBy?: string;
}

/**
 * Edit an already-approved item. Price/promo go into `approved_override`
 * (extracted is preserved). Rematch = undo old mapping chain + approve new product.
 */
export async function updateApprovedItem(
  itemId: string,
  body: UpdateApprovedBody,
): Promise<ApproveResult> {
  const hasAny =
    body.productId !== undefined ||
    body.price !== undefined ||
    body.promoPrice !== undefined ||
    body.promoText !== undefined ||
    body.note !== undefined;
  if (!hasAny) throw new ItemError('invalid', 'Empty body: provide at least one field to update.');

  const { data, error } = await db
    .from('revista_review_items')
    .select(
      'id, magazine_id, supermarket_id, status, proposed_product_id, method, extracted, approved_override, resulting_supermarket_product_id, resulting_snapshot_id',
    )
    .eq('id', itemId)
    .maybeSingle();
  if (error) throw error;
  const item = data as ReviewItemRow | null;
  if (!item) throw new ItemError('not_found', 'Review item not found');
  if (item.status !== 'approved') {
    throw new ItemError('conflict', `Item is ${item.status}; only approved items can be patched.`);
  }
  await assertMagazineCarryActive(item.magazine_id);

  const rematch =
    body.productId != null &&
    body.productId !== item.proposed_product_id;

  if (rematch) {
    // Undo old approval effects, then re-approve against the new product.
    await undoApprovalEffects(item);
    const reApprove = await db
      .from('revista_review_items')
      .update({
        status: 'pending',
        reviewed_by: null,
        reviewed_at: null,
        note: null,
        resulting_supermarket_product_id: null,
        resulting_snapshot_id: null,
        approved_override: null,
      })
      .eq('id', itemId);
    if (reApprove.error) throw reApprove.error;

    return approveReviewItem(itemId, {
      productId: body.productId,
      price: body.price ?? item.extracted?.price ?? undefined,
      promoPrice:
        body.promoPrice !== undefined
          ? (body.promoPrice ?? undefined)
          : (item.extracted?.promo_price ?? undefined),
      promoText:
        body.promoText !== undefined
          ? (body.promoText ?? undefined)
          : (item.extracted?.promo_text ?? undefined),
      note: body.note ?? undefined,
      reviewedBy: body.reviewedBy,
    });
  }

  const prevOverride = item.approved_override ?? {};
  const override = {
    price: body.price !== undefined ? body.price : (prevOverride.price ?? null),
    promo_price:
      body.promoPrice !== undefined ? body.promoPrice : (prevOverride.promo_price ?? null),
    promo_text:
      body.promoText !== undefined
        ? body.promoText === ''
          ? null
          : body.promoText
        : (prevOverride.promo_text ?? null),
  };

  const prices: SnapshotPrices = {
    price: override.price ?? item.extracted?.price ?? null,
    promoPrice: override.promo_price ?? item.extracted?.promo_price ?? null,
    promoText: override.promo_text ?? item.extracted?.promo_text ?? null,
  };
  if (prices.price == null && prices.promoPrice == null) {
    throw new ItemError('invalid', 'No price to record after update.');
  }

  const productId = item.proposed_product_id;
  if (!productId) {
    throw new ItemError('invalid', 'Approved item has no product_id.');
  }

  const spId =
    item.resulting_supermarket_product_id ??
    (await ensureSupermarketProduct(item.supermarket_id, productId, item.magazine_id));

  const snapshotId = await ensureTodayRevistaSnapshot({
    supermarketProductId: spId,
    prices,
    siteProductName: item.extracted?.name ?? null,
    tierUsed: 'manual',
  });

  const upd = await db
    .from('revista_review_items')
    .update({
      approved_override: override,
      note: body.note !== undefined ? body.note : undefined,
      reviewed_by: body.reviewedBy ?? undefined,
      reviewed_at: new Date().toISOString(),
      resulting_supermarket_product_id: spId,
      resulting_snapshot_id: snapshotId,
      method: 'manual',
    })
    .eq('id', itemId);
  if (upd.error) throw upd.error;

  logger.info({ itemId, productId, spId, snapshotId }, 'revista: approved item updated');
  return { itemId, status: 'approved', supermarketProductId: spId, snapshotId, productId };
}

export interface UndoResult {
  itemId: string;
  status: 'pending';
  snapshotDeleted: boolean;
}

/**
 * Undo an approval: delete the approval snapshot + its carry-forward chain
 * (or pause the mapping if nothing usable remains), reset item to pending,
 * and reopen the magazine for review.
 */
export async function undoApprovedItem(itemId: string): Promise<UndoResult> {
  const { data, error } = await db
    .from('revista_review_items')
    .select(
      'id, magazine_id, supermarket_id, status, proposed_product_id, resulting_supermarket_product_id, resulting_snapshot_id',
    )
    .eq('id', itemId)
    .maybeSingle();
  if (error) throw error;
  const item = data as ReviewItemRow | null;
  if (!item) throw new ItemError('not_found', 'Review item not found');
  if (item.status !== 'approved') {
    throw new ItemError('conflict', `Item is ${item.status}; only approved items can be undone.`);
  }

  const snapshotDeleted = await undoApprovalEffects(item);

  const upd = await db
    .from('revista_review_items')
    .update({
      status: 'pending',
      reviewed_by: null,
      reviewed_at: null,
      note: null,
      approved_override: null,
      resulting_supermarket_product_id: null,
      resulting_snapshot_id: null,
    })
    .eq('id', itemId);
  if (upd.error) throw upd.error;

  // Reopen magazine so it resurfaces in /pending.
  await db
    .from('revista_magazines')
    .update({ status: 'in_review', reviewed_at: null })
    .eq('id', item.magazine_id)
    .eq('status', 'reviewed');

  logger.info({ itemId, snapshotDeleted }, 'revista: approval undone');
  return { itemId, status: 'pending', snapshotDeleted };
}

/**
 * Delete the approval snapshot and any carry-forward descendants; also drop
 * today's revista snapshot for the mapping so the export clears immediately.
 * Pause the mapping when no other approved revista item still points at it.
 */
async function undoApprovalEffects(item: ReviewItemRow): Promise<boolean> {
  const spId = item.resulting_supermarket_product_id;
  const rootId = item.resulting_snapshot_id;
  const toDelete = new Set<number>();
  if (rootId != null) toDelete.add(rootId);

  if (spId) {
    const { data, error } = await db
      .from('price_snapshots')
      .select('id, scraped_at, raw_data')
      .eq('supermarket_product_id', spId)
      .is('scrape_run_id', null);
    if (error) throw error;

    const rows = (data ?? []) as Array<{
      id: number;
      scraped_at: string;
      raw_data: { source?: string; from_snapshot_id?: number } | null;
    }>;

    // Walk from_snapshot_id descendants of the approval root.
    let grew = true;
    while (grew) {
      grew = false;
      for (const row of rows) {
        if (toDelete.has(row.id)) continue;
        const from = row.raw_data?.from_snapshot_id;
        if (from != null && toDelete.has(from)) {
          toDelete.add(row.id);
          grew = true;
        }
      }
    }

    // Also clear today's revista row(s) so client_base drops the price today.
    const today = buenosAiresDate();
    for (const row of rows) {
      const src = row.raw_data?.source;
      if (src && src !== 'revista' && src !== 'revista-carry-forward') continue;
      if (buenosAiresDate(new Date(row.scraped_at)) === today) toDelete.add(row.id);
    }
  }

  let deleted = false;
  if (toDelete.size > 0) {
    const { error: delErr } = await db
      .from('price_snapshots')
      .delete()
      .in('id', [...toDelete]);
    if (delErr) throw delErr;
    deleted = true;
  }

  // Pause the mapping so carry-forward skips it and client_base hides it,
  // unless another approved revista item still points at it.
  if (spId) {
    const { count } = await db
      .from('revista_review_items')
      .select('id', { count: 'exact', head: true })
      .eq('resulting_supermarket_product_id', spId)
      .eq('status', 'approved')
      .neq('id', item.id);
    if ((count ?? 0) === 0) {
      await db.from('supermarket_products').update({ is_active: false }).eq('id', spId);
    }
  }

  return deleted;
}

/**
 * Same-day reset when a new magazine supersedes the previous one of the SAME
 * SERIES: delete today's run-less revista snapshots for mappings that were
 * approved on the superseded magazines of that series and are NOT yet approved
 * on `newMagazineId`.
 *
 * Scoped by series so a new Makro MM issue does not wipe GT / Folder prices
 * that were carried forward this morning. Needed because carry-forward runs
 * BEFORE discovery in the orchestrator, so A may already have been carried
 * today. History on prior days is kept.
 */
export async function purgeTodayRevistaSnapshotsNotApprovedOn(
  supermarketId: string,
  newMagazineId: string,
): Promise<number> {
  // Series of the new magazine — only purge within this series.
  const magRes = await db
    .from('revista_magazines')
    .select('id, series_key')
    .eq('id', newMagazineId)
    .single();
  if (magRes.error) throw magRes.error;
  const seriesKey = (magRes.data.series_key as string | null) ?? 'default';

  // Magazines of this series that this new issue just superseded (or any older
  // ones already pointing at it).
  const oldMagsRes = await db
    .from('revista_magazines')
    .select('id')
    .eq('supermarket_id', supermarketId)
    .eq('series_key', seriesKey)
    .eq('superseded_by', newMagazineId);
  if (oldMagsRes.error) throw oldMagsRes.error;
  const oldMagazineIds = (oldMagsRes.data ?? []).map((r) => r.id as string);
  if (oldMagazineIds.length === 0) return 0;

  // Mappings approved on the NEW magazine stay (keep).
  const approvedRes = await db
    .from('revista_review_items')
    .select('resulting_supermarket_product_id')
    .eq('magazine_id', newMagazineId)
    .eq('status', 'approved')
    .not('resulting_supermarket_product_id', 'is', null);
  if (approvedRes.error) throw approvedRes.error;

  const keep = new Set(
    (approvedRes.data ?? [])
      .map((r) => r.resulting_supermarket_product_id as string | null)
      .filter((id): id is string => Boolean(id)),
  );

  // Mappings that had an approval on a superseded magazine of THIS series.
  const oldItemsRes = await db
    .from('revista_review_items')
    .select('resulting_supermarket_product_id')
    .in('magazine_id', oldMagazineIds)
    .eq('status', 'approved')
    .not('resulting_supermarket_product_id', 'is', null);
  if (oldItemsRes.error) throw oldItemsRes.error;

  const candidateSpIds = [
    ...new Set(
      (oldItemsRes.data ?? [])
        .map((r) => r.resulting_supermarket_product_id as string | null)
        .filter((id): id is string => typeof id === 'string' && id.length > 0 && !keep.has(id)),
    ),
  ];
  if (candidateSpIds.length === 0) return 0;

  return purgeTodayRevistaSnapshotsForMappings(candidateSpIds);
}

/**
 * Delete today's (Buenos Aires) run-less revista snapshots for the given
 * mappings, so the client base drops those prices immediately. Only touches
 * revista-owned run-less rows; leaves manual / scraped rows alone.
 */
export async function purgeTodayRevistaSnapshotsForMappings(
  spIds: string[],
): Promise<number> {
  if (spIds.length === 0) return 0;
  const today = buenosAiresDate();
  const toDelete: number[] = [];

  for (const spId of spIds) {
    const { data, error } = await db
      .from('price_snapshots')
      .select('id, scraped_at, raw_data')
      .eq('supermarket_product_id', spId)
      .is('scrape_run_id', null);
    if (error) throw error;

    for (const snap of data ?? []) {
      const src = (snap.raw_data as { source?: string } | null)?.source;
      if (src && src !== 'revista' && src !== 'revista-carry-forward') continue;
      if (buenosAiresDate(new Date(snap.scraped_at as string)) === today) {
        toDelete.push(snap.id as number);
      }
    }
  }

  if (toDelete.length === 0) return 0;

  const { error: delErr } = await db.from('price_snapshots').delete().in('id', toDelete);
  if (delErr) throw delErr;
  return toDelete.length;
}

/**
 * After magazine B supersedes A (same series): pause mappings that were only
 * approved on the superseded magazines and have NO approval on any CURRENT
 * magazine of this chain. client_base already hides is_active=false, so the
 * export drops them immediately (not just via today's snapshot purge).
 *
 * A product also approved on another concurrent series (e.g. GT while MM just
 * arrived) is kept active.
 */
export async function pauseSupersededSeriesMappings(
  supermarketId: string,
  newMagazineId: string,
): Promise<number> {
  const magRes = await db
    .from('revista_magazines')
    .select('id, series_key')
    .eq('id', newMagazineId)
    .single();
  if (magRes.error) throw magRes.error;
  const seriesKey = (magRes.data.series_key as string | null) ?? 'default';

  const oldMagsRes = await db
    .from('revista_magazines')
    .select('id')
    .eq('supermarket_id', supermarketId)
    .eq('series_key', seriesKey)
    .eq('superseded_by', newMagazineId);
  if (oldMagsRes.error) throw oldMagsRes.error;
  const oldMagazineIds = (oldMagsRes.data ?? []).map((r) => r.id as string);
  if (oldMagazineIds.length === 0) return 0;

  const oldItemsRes = await db
    .from('revista_review_items')
    .select('resulting_supermarket_product_id')
    .in('magazine_id', oldMagazineIds)
    .eq('status', 'approved')
    .not('resulting_supermarket_product_id', 'is', null);
  if (oldItemsRes.error) throw oldItemsRes.error;

  const candidateSpIds = [
    ...new Set(
      (oldItemsRes.data ?? [])
        .map((r) => r.resulting_supermarket_product_id as string | null)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  ];
  if (candidateSpIds.length === 0) return 0;

  return pauseRevistaMappingsNotOnCurrent(supermarketId, candidateSpIds);
}

/**
 * Pause the given revista mappings unless they still have an approved review
 * item on a CURRENT (non-superseded) magazine of `supermarketId`.
 * Returns how many mappings were paused. Shared by supersede + reconcile.
 */
export async function pauseRevistaMappingsNotOnCurrent(
  supermarketId: string,
  candidateSpIds: string[],
): Promise<number> {
  if (candidateSpIds.length === 0) return 0;

  const currentMagsRes = await db
    .from('revista_magazines')
    .select('id')
    .eq('supermarket_id', supermarketId)
    .is('superseded_by', null)
    .eq('carry_active', true);
  if (currentMagsRes.error) throw currentMagsRes.error;
  const currentMagazineIds = (currentMagsRes.data ?? []).map((r) => r.id as string);

  const keep = new Set<string>();
  if (currentMagazineIds.length > 0) {
    const keepRes = await db
      .from('revista_review_items')
      .select('resulting_supermarket_product_id')
      .in('magazine_id', currentMagazineIds)
      .eq('status', 'approved')
      .not('resulting_supermarket_product_id', 'is', null);
    if (keepRes.error) throw keepRes.error;
    for (const r of keepRes.data ?? []) {
      const id = r.resulting_supermarket_product_id as string | null;
      if (id) keep.add(id);
    }
  }

  const toPause = candidateSpIds.filter((id) => !keep.has(id));
  if (toPause.length === 0) return 0;

  const { error } = await db
    .from('supermarket_products')
    .update({ is_active: false })
    .in('id', toPause)
    .eq('is_active', true);
  if (error) throw error;

  logger.info(
    { supermarketId, paused: toPause.length, kept: candidateSpIds.length - toPause.length },
    'revista: paused mappings not approved on a current magazine',
  );
  return toPause.length;
}

/**
 * One-shot / ops reconcile: pause every active revista mapping of a chain
 * (or all revista chains) whose only approvals live on superseded magazines.
 *
 * When `dryRun` is true, no writes — returns how many would be paused.
 */
export async function reconcileRevistaActiveMappings(
  supermarketId?: string,
  opts: { dryRun?: boolean } = {},
): Promise<{ considered: number; paused: number }> {
  let smIds: string[];
  if (supermarketId) {
    smIds = [supermarketId];
  } else {
    const { data, error } = await db.from('supermarkets').select('id, config').eq('is_active', true);
    if (error) throw error;
    smIds = (data ?? [])
      .filter((s) => (s.config as { source_type?: string } | null)?.source_type === 'revista')
      .map((s) => s.id as string);
  }

  let considered = 0;
  let paused = 0;
  for (const smId of smIds) {
    const { data: mappings, error } = await db
      .from('supermarket_products')
      .select('id')
      .eq('supermarket_id', smId)
      .eq('is_active', true)
      .eq('metadata->>source', 'revista');
    if (error) throw error;
    const ids = (mappings ?? []).map((m) => m.id as string);
    considered += ids.length;

    if (opts.dryRun) {
      // Count what would pause without writing.
      const currentMagsRes = await db
        .from('revista_magazines')
        .select('id')
        .eq('supermarket_id', smId)
        .is('superseded_by', null)
        .eq('carry_active', true);
      if (currentMagsRes.error) throw currentMagsRes.error;
      const currentMagazineIds = (currentMagsRes.data ?? []).map((r) => r.id as string);
      const keep = new Set<string>();
      if (currentMagazineIds.length > 0) {
        const keepRes = await db
          .from('revista_review_items')
          .select('resulting_supermarket_product_id')
          .in('magazine_id', currentMagazineIds)
          .eq('status', 'approved')
          .not('resulting_supermarket_product_id', 'is', null);
        if (keepRes.error) throw keepRes.error;
        for (const r of keepRes.data ?? []) {
          const id = r.resulting_supermarket_product_id as string | null;
          if (id) keep.add(id);
        }
      }
      paused += ids.filter((id) => !keep.has(id)).length;
      continue;
    }

    paused += await pauseRevistaMappingsNotOnCurrent(smId, ids);
  }
  return { considered, paused };
}

// =============================================================================
// Manual magazine on/off switch (carry_active) — migration 018
// =============================================================================

export interface MagazineToggleResult {
  magazineId: string;
  carryActive: boolean;
  /** Mappings paused (deactivate) or re-emitted (reactivate). */
  affectedMappings: number;
  /** Today's snapshots purged (deactivate only). */
  purgedToday: number;
}

interface MagazineToggleRow {
  id: string;
  supermarket_id: string;
  carry_active: boolean;
}

async function loadMagazineForToggle(magazineId: string): Promise<MagazineToggleRow> {
  const { data, error } = await db
    .from('revista_magazines')
    .select('id, supermarket_id, carry_active')
    .eq('id', magazineId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new ItemError('not_found', 'Magazine not found');
  return data as MagazineToggleRow;
}

/** Distinct mappings that have an approved review item on this magazine. */
async function approvedMappingIdsOnMagazine(magazineId: string): Promise<string[]> {
  const { data, error } = await db
    .from('revista_review_items')
    .select('resulting_supermarket_product_id')
    .eq('magazine_id', magazineId)
    .eq('status', 'approved')
    .not('resulting_supermarket_product_id', 'is', null);
  if (error) throw error;
  return [
    ...new Set(
      (data ?? [])
        .map((r) => r.resulting_supermarket_product_id as string | null)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
}

const TOGGLE_SNAPSHOT_COLS =
  'id, price, list_price, offer_price_1, promotion_1, site_product_name, scraped_at';

/** Re-emit today's run-less revista snapshot for a mapping from its latest snapshot. */
async function reEmitTodayFromLatest(spId: string): Promise<boolean> {
  const snapRes = await db
    .from('price_snapshots')
    .select(TOGGLE_SNAPSHOT_COLS)
    .eq('supermarket_product_id', spId)
    .order('scraped_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (snapRes.error) throw snapRes.error;
  const snap = snapRes.data as {
    id: number;
    price: number | null;
    list_price: number | null;
    offer_price_1: number | null;
    promotion_1: string | null;
    site_product_name: string | null;
  } | null;
  if (!snap || snap.price == null) return false;

  await ensureTodayRevistaSnapshot({
    supermarketProductId: spId,
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
  return true;
}

/**
 * Deactivate a magazine: drop ALL its approved prices from the client base at
 * once, WITHOUT un-approving any product. Sets carry_active=false, pauses the
 * mappings it owns (unless another CURRENT + active magazine still keeps them),
 * and purges today's run-less snapshots for the paused ones so the export clears
 * immediately. Reversible via {@link reactivateMagazine}.
 */
export async function deactivateMagazine(magazineId: string): Promise<MagazineToggleResult> {
  const mag = await loadMagazineForToggle(magazineId);

  // Flip the switch FIRST so the keep-set computation excludes this magazine.
  const upd = await db
    .from('revista_magazines')
    .update({ carry_active: false })
    .eq('id', magazineId);
  if (upd.error) throw upd.error;

  const candidateSpIds = await approvedMappingIdsOnMagazine(magazineId);
  if (candidateSpIds.length === 0) {
    return { magazineId, carryActive: false, affectedMappings: 0, purgedToday: 0 };
  }

  const paused = await pauseRevistaMappingsNotOnCurrent(mag.supermarket_id, candidateSpIds);

  // Purge today's snapshots only for the mappings we actually pulled (now paused).
  const { data: inactive, error: inErr } = await db
    .from('supermarket_products')
    .select('id')
    .in('id', candidateSpIds)
    .eq('is_active', false);
  if (inErr) throw inErr;
  const inactiveIds = (inactive ?? []).map((r) => r.id as string);
  const purgedToday = await purgeTodayRevistaSnapshotsForMappings(inactiveIds);

  logger.info(
    { magazineId, supermarketId: mag.supermarket_id, paused, purgedToday },
    'revista: magazine deactivated (carry_active=false)',
  );
  return { magazineId, carryActive: false, affectedMappings: paused, purgedToday };
}

/**
 * Reactivate a magazine: put its approved prices back in the client base. Sets
 * carry_active=true, re-activates the mappings it owns, and re-emits today's
 * price for each so the export shows them again immediately (instead of waiting
 * for tomorrow's carry-forward).
 */
export async function reactivateMagazine(magazineId: string): Promise<MagazineToggleResult> {
  const mag = await loadMagazineForToggle(magazineId);

  const upd = await db
    .from('revista_magazines')
    .update({ carry_active: true })
    .eq('id', magazineId);
  if (upd.error) throw upd.error;

  const candidateSpIds = await approvedMappingIdsOnMagazine(magazineId);
  let affected = 0;
  for (const spId of candidateSpIds) {
    // Re-activate the mapping (carry-forward + client_base need is_active=true).
    const act = await db
      .from('supermarket_products')
      .update({ is_active: true })
      .eq('id', spId)
      .eq('is_active', false);
    if (act.error) throw act.error;

    // Re-emit today's price from the latest known snapshot (same as carry-forward).
    if (await reEmitTodayFromLatest(spId)) affected++;
  }

  logger.info(
    { magazineId, supermarketId: mag.supermarket_id, reEmitted: affected },
    'revista: magazine reactivated (carry_active=true)',
  );
  return { magazineId, carryActive: true, affectedMappings: affected, purgedToday: 0 };
}

export interface MagazineDeleteResult {
  magazineId: string;
  /** Review items removed (cascade from the magazine row). */
  deletedItems: number;
  /** Mappings paused because no other current + active magazine keeps them. */
  pausedMappings: number;
  /** Today's run-less snapshots purged for the paused mappings. */
  purgedToday: number;
  /** Page images removed from Storage. */
  deletedImages: number;
}

/**
 * Delete a magazine entirely — for a flyer the client doesn't care about and
 * wants gone (frees Storage + clears the review queue). Removes the magazine row
 * (cascading its review items), drops its prices from the client base (same
 * pause + purge-today as deactivate), and deletes its page images from Storage.
 * NOT reversible; historical price_snapshots of its mappings are kept.
 */
export async function deleteMagazine(magazineId: string): Promise<MagazineDeleteResult> {
  const mag = await loadMagazineForToggle(magazineId);

  // Capture affected mappings + item count BEFORE the cascade delete.
  const candidateSpIds = await approvedMappingIdsOnMagazine(magazineId);
  const countRes = await db
    .from('revista_review_items')
    .select('id', { count: 'exact', head: true })
    .eq('magazine_id', magazineId);
  if (countRes.error) throw countRes.error;
  const deletedItems = countRes.count ?? 0;

  // Delete the magazine row → cascades revista_review_items (FK ON DELETE CASCADE).
  const delRes = await db.from('revista_magazines').delete().eq('id', magazineId);
  if (delRes.error) throw delRes.error;

  // Drop its prices from the client base. With the magazine (and its items) gone,
  // the keep-set correctly excludes it, so only mappings no other current + active
  // magazine holds get paused; then purge today's snapshots for those.
  let pausedMappings = 0;
  let purgedToday = 0;
  if (candidateSpIds.length > 0) {
    pausedMappings = await pauseRevistaMappingsNotOnCurrent(mag.supermarket_id, candidateSpIds);
    const { data: inactive, error: inErr } = await db
      .from('supermarket_products')
      .select('id')
      .in('id', candidateSpIds)
      .eq('is_active', false);
    if (inErr) throw inErr;
    purgedToday = await purgeTodayRevistaSnapshotsForMappings(
      (inactive ?? []).map((r) => r.id as string),
    );
  }

  // Free Storage (page images) + resolve any open review alert for this magazine.
  const deletedImages = await deleteMagazineImages(magazineId);
  const alertRes = await db
    .from('alerts')
    .update({ status: 'resolved', resolved_at: new Date().toISOString() })
    .eq('type', 'revista_review')
    .eq('status', 'open')
    .contains('context', { magazine_id: magazineId });
  if (alertRes.error) {
    logger.warn({ err: alertRes.error, magazineId }, 'revista: could not resolve alert on delete');
  }

  logger.info(
    { magazineId, supermarketId: mag.supermarket_id, deletedItems, pausedMappings, purgedToday, deletedImages },
    'revista: magazine deleted',
  );
  return { magazineId, deletedItems, pausedMappings, purgedToday, deletedImages };
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
