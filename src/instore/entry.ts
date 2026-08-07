/**
 * Record an in-store price entry — and materialize it on approval.
 *
 * A field worker, physically in the store, scans a barcode and enters:
 *   - price               Precio Regular (unitario)            → snapshot.price
 *   - wholesalePrice      Precio con oferta (precio mayorista)  → snapshot.offer_price_1
 *   - wholesaleMinUnits   a partir de cuántas u. es mayorista   → snapshot.promotion_1 / raw_data
 *   - note                Observaciones                         → raw_data.note
 *
 * DAILY REVIEW GATE (migration 019). A submission no longer writes a snapshot at
 * submit time — it only logs a **pending** `instore_price_entries` row. The
 * client base sees nothing until a back-office operator APPROVES the visit, at
 * which point `materializeInStoreEntry` runs the resolve → mapping → snapshot
 * chain (see src/instore/review.ts). This mirrors the revista review flow: a
 * pending entry isn't a snapshot yet, so the export excludes it automatically.
 */

import { db } from '../shared/db.js';
import { logger } from '../shared/logger.js';
import { ensureMasterProductForEan, resolveEan } from './resolve.js';

/** Synthetic SKU for an in-store mapping (no real site SKU exists). */
export function inStoreExternalId(productId: string): string {
  return `instore-${productId}`;
}

/** Marks mappings/snapshots created by the in-store tool (used by enqueue + review). */
export const IN_STORE_SOURCE = 'instore';

/** A branch location, captured on the visit. */
export interface VisitLocation {
  provincia: string | null;
  localidad: string | null;
  direccion: string | null;
}

export interface InStoreEntryInput {
  /** The PDV visit this entry belongs to (preferred). */
  visitId?: string | null;
  /** Required when there's no visitId. */
  supermarketId?: string;
  ean: string;
  /** Precio Regular (unitario). */
  price: number;
  /** Precio con oferta (precio mayorista). */
  wholesalePrice?: number | null;
  /** A partir de cuántas unidades aplica el precio mayorista. */
  wholesaleMinUnits?: number | null;
  /** Worker name. Required when there's no visitId (else inherited from the visit). */
  enteredBy?: string;
  /** Observaciones. */
  note?: string | null;
  /** The API key that submitted (for the audit log). */
  apiKeyId?: string | null;
}

export interface InStoreEntryResult {
  entryId: string;
  visitId: string | null;
  supermarketId: string;
  ean: string;
  productId: string | null;
  productName: string | null;
  price: number;
  wholesalePrice: number | null;
  wholesaleMinUnits: number | null;
  note: string | null;
  enteredBy: string;
  reviewStatus: string;
  createdAt: string;
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

/** YYYY-MM-DD for a date in Argentina time (the business day the export uses). */
function buenosAiresDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
  }).format(d);
}

/** Build the promo text shown in the export from the wholesale threshold. */
export function wholesalePromoText(
  wholesalePrice: number | null,
  minUnits: number | null,
): string | null {
  if (wholesalePrice == null || wholesalePrice <= 0) return null;
  return minUnits != null ? `Precio mayorista desde ${minUnits} u.` : 'Precio mayorista';
}

/** Ensure the supermarket exists, is active, and is flagged for in-store entry. */
export async function assertInStoreSupermarket(supermarketId: string): Promise<void> {
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
 * Find-or-create the in-store mapping for (supermarket, product). Idempotent via
 * the synthetic external_id + UNIQUE(supermarket_id, external_id): repeated
 * visits reuse the mapping and just append new snapshots.
 */
export async function ensureInStoreMapping(
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

interface SnapshotInput {
  price: number;
  wholesalePrice: number | null;
  wholesaleMinUnits: number | null;
}

/**
 * Write one run-less snapshot for an approved in-store entry.
 *
 * Price semantics keep the client_base export correct without touching the view:
 * `price` = regular unit price (→ Precio_Regular), `offer_price_1` = wholesale
 * price (→ Precio_c_Oferta_1), min-units → promo text (→ Promocion_1).
 */
export async function writeSnapshot(
  supermarketProductId: string,
  prices: SnapshotInput,
  meta: {
    enteredBy: string;
    ean: string;
    apiKeyId: string | null;
    note: string | null;
    visitId: string | null;
    location: VisitLocation | null;
  },
): Promise<number> {
  const wholesale = prices.wholesalePrice != null && prices.wholesalePrice > 0 ? prices.wholesalePrice : null;
  const minUnits = prices.wholesaleMinUnits ?? null;
  const promoText = wholesalePromoText(wholesale, minUnits);
  const promotions = promoText
    ? [{ type: 'wholesale', description: promoText, min_units: minUnits }]
    : [];

  const { data, error } = await db
    .from('price_snapshots')
    .insert({
      supermarket_product_id: supermarketProductId,
      scrape_run_id: null,
      scraped_at: new Date().toISOString(),
      price: prices.price,
      list_price: null,
      offer_price_1: wholesale,
      in_stock: true,
      currency: 'ARS',
      tier_used: 'manual',
      status: 'ok',
      promotions,
      promotion_1: promoText,
      raw_data: {
        source: IN_STORE_SOURCE,
        entered_by: meta.enteredBy,
        ean: meta.ean,
        api_key_id: meta.apiKeyId,
        note: meta.note,
        visit_id: meta.visitId,
        wholesale_min_units: minUnits,
        provincia: meta.location?.provincia ?? null,
        localidad: meta.location?.localidad ?? null,
        direccion: meta.location?.direccion ?? null,
      },
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as number;
}

/**
 * Drop any run-less in-store snapshot for this mapping already dated today (an
 * earlier approval, or a legacy carry-forward re-emission), so an approved fresh
 * price is the single row for the day. Keeps the export clean (one row per
 * mapping/day). The 'instore-carry-forward' source is matched only to clean up
 * rows written before carry-forward was removed.
 */
async function purgeSameDayInStoreSnapshots(supermarketProductId: string): Promise<void> {
  const { data, error } = await db
    .from('price_snapshots')
    .select('id, scraped_at, raw_data')
    .eq('supermarket_product_id', supermarketProductId)
    .is('scrape_run_id', null)
    .order('id', { ascending: false })
    .limit(50);
  if (error) throw error;

  const today = buenosAiresDate(new Date());
  const toDelete = (data ?? [])
    .filter((r) => {
      const src = (r.raw_data as { source?: string } | null)?.source ?? '';
      const isInStore = src === IN_STORE_SOURCE || src === 'instore-carry-forward';
      return isInStore && buenosAiresDate(new Date(r.scraped_at as string)) === today;
    })
    .map((r) => r.id as number);

  if (toDelete.length === 0) return;
  const { error: delErr } = await db.from('price_snapshots').delete().in('id', toDelete);
  if (delErr) throw delErr;
}

export interface MaterializeInput {
  supermarketId: string;
  ean: string;
  price: number;
  wholesalePrice: number | null;
  wholesaleMinUnits: number | null;
  enteredBy: string;
  note: string | null;
  visitId: string | null;
  location: VisitLocation | null;
  apiKeyId: string | null;
}

export interface MaterializeResult {
  productId: string;
  supermarketProductId: string;
  snapshotId: number;
}

/**
 * Turn an approved entry into a live price: resolve/create the master product,
 * ensure the mapping, drop any same-day in-store snapshot, and write the
 * run-less snapshot. Called from the review approval flow.
 */
export async function materializeInStoreEntry(input: MaterializeInput): Promise<MaterializeResult> {
  const productId = await ensureMasterProductForEan(input.ean);
  if (!productId) {
    throw new InStoreError('not_found', `EAN ${input.ean} is not in the catalog`);
  }
  const spId = await ensureInStoreMapping(input.supermarketId, productId);
  await purgeSameDayInStoreSnapshots(spId);
  const snapshotId = await writeSnapshot(
    spId,
    { price: input.price, wholesalePrice: input.wholesalePrice, wholesaleMinUnits: input.wholesaleMinUnits },
    {
      enteredBy: input.enteredBy,
      ean: input.ean,
      apiKeyId: input.apiKeyId,
      note: input.note,
      visitId: input.visitId,
      location: input.location,
    },
  );
  return { productId, supermarketProductId: spId, snapshotId };
}

interface VisitContext {
  supermarketId: string;
  enteredBy: string;
}

/** Resolve the visit (if any) to the store/worker used for the entry. */
async function resolveContext(input: InStoreEntryInput): Promise<VisitContext> {
  if (input.visitId) {
    const { data, error } = await db
      .from('instore_visits')
      .select('id, supermarket_id, entered_by, status')
      .eq('id', input.visitId)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new InStoreError('not_found', 'Visit not found');
    if (data.status === 'finished') {
      throw new InStoreError('invalid', 'Visit is already finished');
    }
    return {
      supermarketId: data.supermarket_id as string,
      enteredBy: input.enteredBy?.trim() || (data.entered_by as string),
    };
  }

  if (!input.supermarketId) {
    throw new InStoreError('invalid', 'supermarket_id is required when no visit_id is given');
  }
  if (!input.enteredBy?.trim()) {
    throw new InStoreError('invalid', 'entered_by is required when no visit_id is given');
  }
  await assertInStoreSupermarket(input.supermarketId);
  return { supermarketId: input.supermarketId, enteredBy: input.enteredBy.trim() };
}

/**
 * Record one in-store submission as a PENDING entry (no snapshot yet — that
 * happens on approval). Validates the EAN is in the catalog and captures the
 * product name for the review screen. Throws InStoreError for caller mistakes.
 */
export async function recordInStoreEntry(
  input: InStoreEntryInput,
): Promise<InStoreEntryResult> {
  const ctx = await resolveContext(input);

  // Read-only resolve: validate the EAN and capture a display name. Master
  // product creation is deferred to approval (materializeInStoreEntry).
  const resolved = await resolveEan(input.ean);
  if (!resolved) {
    throw new InStoreError('not_found', `EAN ${input.ean} is not in the catalog`);
  }

  const wholesalePrice =
    input.wholesalePrice != null && input.wholesalePrice > 0 ? input.wholesalePrice : null;
  const wholesaleMinUnits = input.wholesaleMinUnits ?? null;
  const promoText = wholesalePromoText(wholesalePrice, wholesaleMinUnits);

  const entryInsert = await db
    .from('instore_price_entries')
    .insert({
      visit_id: input.visitId ?? null,
      supermarket_id: ctx.supermarketId,
      ean: input.ean,
      product_id: resolved.productId,
      product_name: resolved.name,
      price: input.price,
      list_price: null,
      promo_price: wholesalePrice,
      promo_min_units: wholesaleMinUnits,
      promo_text: promoText,
      entered_by: ctx.enteredBy,
      api_key_id: input.apiKeyId ?? null,
      note: input.note ?? null,
      review_status: 'pending',
    })
    .select('id, created_at, review_status')
    .single();
  if (entryInsert.error) throw entryInsert.error;

  logger.info(
    { visitId: input.visitId ?? null, supermarketId: ctx.supermarketId, ean: input.ean, enteredBy: ctx.enteredBy },
    'instore: pending price entry recorded',
  );

  return {
    entryId: entryInsert.data.id as string,
    visitId: input.visitId ?? null,
    supermarketId: ctx.supermarketId,
    ean: input.ean,
    productId: resolved.productId,
    productName: resolved.name,
    price: input.price,
    wholesalePrice,
    wholesaleMinUnits,
    note: input.note ?? null,
    enteredBy: ctx.enteredBy,
    reviewStatus: entryInsert.data.review_status as string,
    createdAt: entryInsert.data.created_at as string,
  };
}
