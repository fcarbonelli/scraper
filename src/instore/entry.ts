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
  /** Precio Regular (unitario). Omit (with noPrice=true) when the price is unknown. */
  price?: number | null;
  /** Precio con oferta (precio mayorista). */
  wholesalePrice?: number | null;
  /** A partir de cuántas unidades aplica el precio mayorista. */
  wholesaleMinUnits?: number | null;
  /**
   * "Sin precio / hay stock": the worker saw the product but couldn't read a
   * price. Records a price-less entry that publishes as a marker on approval.
   */
  noPrice?: boolean;
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
  /** null for "sin precio" entries. */
  price: number | null;
  wholesalePrice: number | null;
  wholesaleMinUnits: number | null;
  noPrice: boolean;
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
  if (inserted.error) {
    // Parallel approve of two entries for the same EAN can race on insert.
    // Unique violation → re-read the winner.
    if (inserted.error.code === '23505') {
      const retry = await db
        .from('supermarket_products')
        .select('id')
        .eq('supermarket_id', supermarketId)
        .eq('external_id', externalId)
        .maybeSingle();
      if (retry.error) throw retry.error;
      if (retry.data) return retry.data.id as string;
    }
    throw inserted.error;
  }
  return inserted.data.id as string;
}

interface SnapshotInput {
  /** null when noPrice is true. */
  price: number | null;
  wholesalePrice: number | null;
  wholesaleMinUnits: number | null;
  /** "Sin precio / hay stock" — write a price-less marker row. */
  noPrice: boolean;
}

/**
 * Write one run-less snapshot for an approved in-store entry.
 *
 * Price semantics keep the client_base export correct without touching the view:
 * `price` = regular unit price (→ Precio_Regular), `offer_price_1` = wholesale
 * price (→ Precio_c_Oferta_1), min-units → promo text (→ Promocion_1).
 *
 * "Sin precio" entries (noPrice) write a MARKER row exactly like the scraper's
 * out_of_stock markers: status='no_price', price/offers all NULL, in_stock=true.
 * The export shows the product with Estado="En stock sin precio" and no price.
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
  const wholesale =
    !prices.noPrice && prices.wholesalePrice != null && prices.wholesalePrice > 0
      ? prices.wholesalePrice
      : null;
  const minUnits = prices.noPrice ? null : prices.wholesaleMinUnits ?? null;
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
      price: prices.noPrice ? null : prices.price,
      list_price: null,
      offer_price_1: wholesale,
      in_stock: true,
      currency: 'ARS',
      tier_used: 'manual',
      status: prices.noPrice ? 'no_price' : 'ok',
      promotions,
      promotion_1: promoText,
      raw_data: {
        source: IN_STORE_SOURCE,
        entered_by: meta.enteredBy,
        ean: meta.ean,
        api_key_id: meta.apiKeyId,
        note: meta.note,
        visit_id: meta.visitId,
        no_price: prices.noPrice,
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
  /** null when noPrice is true. */
  price: number | null;
  wholesalePrice: number | null;
  wholesaleMinUnits: number | null;
  noPrice: boolean;
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
    {
      price: input.noPrice ? null : input.price,
      wholesalePrice: input.wholesalePrice,
      wholesaleMinUnits: input.wholesaleMinUnits,
      noPrice: input.noPrice,
    },
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

  // "Sin precio / hay stock": price-less marker. Otherwise a real price is
  // required (validated at the route too, but guard here for direct callers).
  const noPrice = input.noPrice === true;
  if (!noPrice && (input.price == null || input.price <= 0)) {
    throw new InStoreError('invalid', 'A positive price is required (or set no_price=true)');
  }

  const price = noPrice ? null : (input.price as number);
  const wholesalePrice =
    !noPrice && input.wholesalePrice != null && input.wholesalePrice > 0 ? input.wholesalePrice : null;
  const wholesaleMinUnits = noPrice ? null : input.wholesaleMinUnits ?? null;
  const promoText = wholesalePromoText(wholesalePrice, wholesaleMinUnits);

  const entryInsert = await db
    .from('instore_price_entries')
    .insert({
      visit_id: input.visitId ?? null,
      supermarket_id: ctx.supermarketId,
      ean: input.ean,
      product_id: resolved.productId,
      product_name: resolved.name,
      price,
      no_price: noPrice,
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
    { visitId: input.visitId ?? null, supermarketId: ctx.supermarketId, ean: input.ean, enteredBy: ctx.enteredBy, noPrice },
    'instore: pending price entry recorded',
  );

  return {
    entryId: entryInsert.data.id as string,
    visitId: input.visitId ?? null,
    supermarketId: ctx.supermarketId,
    ean: input.ean,
    productId: resolved.productId,
    productName: resolved.name,
    price,
    wholesalePrice,
    wholesaleMinUnits,
    noPrice,
    note: input.note ?? null,
    enteredBy: ctx.enteredBy,
    reviewStatus: entryInsert.data.review_status as string,
    createdAt: entryInsert.data.created_at as string,
  };
}

/** Editable fields on a saved entry. Any omitted field is left unchanged. */
export interface UpdateEntryInput {
  /** Precio Regular (unitario). Providing a price clears the no_price flag. */
  price?: number;
  /** Precio con oferta (precio mayorista). null clears it. */
  wholesalePrice?: number | null;
  /** A partir de cuántas unidades aplica el precio mayorista. null clears it. */
  wholesaleMinUnits?: number | null;
  /** "Sin precio / hay stock". Setting true clears the price + wholesale fields. */
  noPrice?: boolean;
  /** Observaciones. null clears it. */
  note?: string | null;
}

interface EntryRow {
  id: string;
  visit_id: string | null;
  supermarket_id: string;
  ean: string;
  product_id: string | null;
  product_name: string | null;
  price: number | null;
  no_price: boolean;
  promo_price: number | null;
  promo_min_units: number | null;
  note: string | null;
  entered_by: string;
  review_status: string;
  created_at: string;
}

/**
 * Edit a still-PENDING entry in place (price / wholesale / min-units /
 * observaciones) and persist it — no approval needed. This powers the "fix a
 * price I already saved" flow in the relevamiento view.
 *
 * Only pending entries are editable here: once a visit is approved the entry has
 * materialized a live snapshot, so corrections then go through the review flow.
 */
export async function updatePendingEntry(
  entryId: string,
  patch: UpdateEntryInput,
): Promise<InStoreEntryResult> {
  const { data, error } = await db
    .from('instore_price_entries')
    .select(
      'id, visit_id, supermarket_id, ean, product_id, product_name, price, no_price, promo_price, promo_min_units, note, entered_by, review_status, created_at',
    )
    .eq('id', entryId)
    .maybeSingle();
  if (error) throw error;
  const entry = data as EntryRow | null;
  if (!entry) throw new InStoreError('not_found', 'Entry not found');
  if (entry.review_status !== 'pending') {
    throw new InStoreError('invalid', `Cannot edit a ${entry.review_status} entry`);
  }

  // Resolve the target no_price state: explicit flag wins; else providing a
  // price implies a real price (clears no_price); else keep as-is.
  const noPrice =
    patch.noPrice !== undefined ? patch.noPrice : patch.price !== undefined ? false : entry.no_price;

  const note = patch.note !== undefined ? patch.note : entry.note;

  let price: number | null;
  let wholesalePrice: number | null;
  let wholesaleMinUnits: number | null;
  if (noPrice) {
    // Marker entry — no price/wholesale.
    price = null;
    wholesalePrice = null;
    wholesaleMinUnits = null;
  } else {
    price = patch.price ?? entry.price;
    if (price == null || price <= 0) {
      throw new InStoreError('invalid', 'A positive price is required (or set no_price=true)');
    }
    wholesalePrice =
      patch.wholesalePrice !== undefined
        ? patch.wholesalePrice != null && patch.wholesalePrice > 0
          ? patch.wholesalePrice
          : null
        : entry.promo_price;
    wholesaleMinUnits =
      patch.wholesaleMinUnits !== undefined ? patch.wholesaleMinUnits : entry.promo_min_units;
  }
  const promoText = wholesalePromoText(wholesalePrice, wholesaleMinUnits);

  const upd = await db
    .from('instore_price_entries')
    .update({
      price,
      no_price: noPrice,
      promo_price: wholesalePrice,
      promo_min_units: wholesaleMinUnits,
      promo_text: promoText,
      note,
    })
    .eq('id', entryId)
    .select('id, review_status, created_at')
    .single();
  if (upd.error) throw upd.error;

  logger.info({ entryId, visitId: entry.visit_id, noPrice }, 'instore: pending entry updated');

  return {
    entryId: entry.id,
    visitId: entry.visit_id,
    supermarketId: entry.supermarket_id,
    ean: entry.ean,
    productId: entry.product_id,
    productName: entry.product_name,
    price,
    wholesalePrice,
    wholesaleMinUnits,
    noPrice,
    note,
    enteredBy: entry.entered_by,
    reviewStatus: upd.data.review_status as string,
    createdAt: upd.data.created_at as string,
  };
}
