/**
 * Record an in-store price entry.
 *
 * A field worker, physically in the store, scans a barcode and enters the price
 * fields the client asked for:
 *   - price               Precio Regular (unitario)          → snapshot.price
 *   - wholesalePrice      Precio con oferta (precio mayorista) → snapshot.offer_price_1
 *   - wholesaleMinUnits   a partir de cuántas u. es mayorista  → snapshot.promotion_1 / raw_data
 *   - note                Observaciones                        → raw_data.note
 *
 * The submission:
 *   1. resolves the EAN to a master product (creating one from catalog if
 *      needed — see resolve.ts),
 *   2. ensures a `supermarket_products` mapping for (store, product),
 *   3. writes ONE run-less `price_snapshots` row (trusted, always
 *      client-visible; carried forward daily until superseded),
 *   4. logs the submission to `instore_price_entries` (linked to the PDV visit).
 *
 * Entries normally belong to a visit (see visits.ts): the visit carries the
 * store, the worker name, and the branch location. Passing `supermarketId` +
 * `enteredBy` directly (no visit) is still supported for one-off submissions.
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
  productId: string;
  supermarketProductId: string;
  snapshotId: number;
  price: number;
  wholesalePrice: number | null;
  wholesaleMinUnits: number | null;
  enteredBy: string;
  note: string | null;
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

interface SnapshotInput {
  price: number;
  wholesalePrice: number | null;
  wholesaleMinUnits: number | null;
}

/**
 * Write one run-less snapshot for an in-store entry.
 *
 * Price semantics chosen so the client_base export is correct without touching
 * the view: `price` = the regular unit price (→ Precio_Regular), `offer_price_1`
 * = the wholesale price (→ Precio_c_Oferta_1), and the min-units threshold
 * becomes the promo text (→ Promocion_1). `list_price` stays null.
 */
async function writeSnapshot(
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
  const promoText =
    wholesale != null
      ? minUnits != null
        ? `Precio mayorista desde ${minUnits} u.`
        : 'Precio mayorista'
      : null;
  const promotions = promoText
    ? [{ type: 'wholesale', description: promoText, min_units: minUnits }]
    : [];

  const { data, error } = await db
    .from('price_snapshots')
    .insert({
      supermarket_product_id: supermarketProductId,
      // Run-less: operator-trusted, always client-visible, no publish gate.
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

interface VisitContext {
  supermarketId: string;
  enteredBy: string;
  location: VisitLocation | null;
}

/** Resolve the visit (if any) to the store/worker/location used for the entry. */
async function resolveContext(input: InStoreEntryInput): Promise<VisitContext> {
  if (input.visitId) {
    const { data, error } = await db
      .from('instore_visits')
      .select('id, supermarket_id, entered_by, provincia, localidad, direccion, status')
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
      location: {
        provincia: (data.provincia as string | null) ?? null,
        localidad: (data.localidad as string | null) ?? null,
        direccion: (data.direccion as string | null) ?? null,
      },
    };
  }

  // No visit: caller must supply store + worker directly.
  if (!input.supermarketId) {
    throw new InStoreError('invalid', 'supermarket_id is required when no visit_id is given');
  }
  if (!input.enteredBy?.trim()) {
    throw new InStoreError('invalid', 'entered_by is required when no visit_id is given');
  }
  await assertInStoreSupermarket(input.supermarketId);
  return { supermarketId: input.supermarketId, enteredBy: input.enteredBy.trim(), location: null };
}

/**
 * Record one in-store price submission end to end. Throws InStoreError for
 * caller mistakes (unknown store/visit, EAN not in catalog); the route maps
 * those to HTTP status codes.
 */
export async function recordInStoreEntry(
  input: InStoreEntryInput,
): Promise<InStoreEntryResult> {
  const ctx = await resolveContext(input);

  const productId = await ensureMasterProductForEan(input.ean);
  if (!productId) {
    throw new InStoreError('not_found', `EAN ${input.ean} is not in the catalog`);
  }

  const spId = await ensureInStoreMapping(ctx.supermarketId, productId);

  const wholesalePrice =
    input.wholesalePrice != null && input.wholesalePrice > 0 ? input.wholesalePrice : null;
  const wholesaleMinUnits = input.wholesaleMinUnits ?? null;

  const snapshotId = await writeSnapshot(
    spId,
    { price: input.price, wholesalePrice, wholesaleMinUnits },
    {
      enteredBy: ctx.enteredBy,
      ean: input.ean,
      apiKeyId: input.apiKeyId ?? null,
      note: input.note ?? null,
      visitId: input.visitId ?? null,
      location: ctx.location,
    },
  );

  const promoText =
    wholesalePrice != null && wholesaleMinUnits != null
      ? `Precio mayorista desde ${wholesaleMinUnits} u.`
      : null;

  const entryInsert = await db
    .from('instore_price_entries')
    .insert({
      visit_id: input.visitId ?? null,
      supermarket_id: ctx.supermarketId,
      ean: input.ean,
      product_id: productId,
      resulting_supermarket_product_id: spId,
      resulting_snapshot_id: snapshotId,
      price: input.price,
      list_price: null,
      promo_price: wholesalePrice,
      promo_min_units: wholesaleMinUnits,
      promo_text: promoText,
      entered_by: ctx.enteredBy,
      api_key_id: input.apiKeyId ?? null,
      note: input.note ?? null,
    })
    .select('id, created_at')
    .single();
  if (entryInsert.error) throw entryInsert.error;

  logger.info(
    { visitId: input.visitId ?? null, supermarketId: ctx.supermarketId, ean: input.ean, productId, spId, snapshotId, enteredBy: ctx.enteredBy },
    'instore: price entry recorded',
  );

  return {
    entryId: entryInsert.data.id as string,
    visitId: input.visitId ?? null,
    supermarketId: ctx.supermarketId,
    ean: input.ean,
    productId,
    supermarketProductId: spId,
    snapshotId,
    price: input.price,
    wholesalePrice,
    wholesaleMinUnits,
    enteredBy: ctx.enteredBy,
    note: input.note ?? null,
    createdAt: entryInsert.data.created_at as string,
  };
}
