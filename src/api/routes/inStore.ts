/**
 * In-store manual price-entry routes.
 *
 *   GET  /v1/in-store/supermarkets   chains to show in the store dropdown
 *   GET  /v1/in-store/lookup?ean=    resolve a scanned EAN to a catalog product
 *   POST /v1/in-store/entries        submit a scanned price (mapping + snapshot)
 *   GET  /v1/in-store/entries        recent submissions (today's list / review)
 *
 * These power a mobile web tool used by field workers in physical (mostly
 * wholesale) stores. Auth is the platform-standard X-API-Key; the app embeds a
 * key scoped to `in-store` (see enforceScopes) so a leak can't touch the rest
 * of the API. Contract + UX: docs/IN_STORE_PRICE_ENTRY.md.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { db } from '../../shared/db.js';
import { ApiError } from '../lib/apiError.js';
import { paginated, success } from '../lib/envelope.js';
import { parseBody, parseQuery, PaginationQuery } from '../lib/parseQuery.js';
import { resolveEan } from '../../instore/resolve.js';
import { recordInStoreEntry, InStoreError } from '../../instore/entry.js';

export const inStoreRouter = Router();

/** Argentina is UTC-3 year-round (no DST) — the offset the export's day uses. */
const AR_OFFSET = '-03:00';

/** Today's date (YYYY-MM-DD) in Buenos Aires. */
function todayInBuenosAires(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
  }).format(new Date());
}

/** UTC [from, to) range covering one Buenos Aires calendar day. */
function baDayRangeUtc(date: string): { fromUtc: string; toUtc: string } {
  const fromUtc = new Date(`${date}T00:00:00${AR_OFFSET}`).toISOString();
  const toUtc = new Date(`${date}T00:00:00${AR_OFFSET}`);
  toUtc.setUTCDate(toUtc.getUTCDate() + 1);
  return { fromUtc, toUtc: toUtc.toISOString() };
}

// =============================================================================
// GET /v1/in-store/supermarkets — the store dropdown
// =============================================================================
interface SupermarketRow {
  id: string;
  name: string;
  cadena_display_name: string | null;
  config: { instore?: { enabled?: boolean } } | null;
}

inStoreRouter.get('/supermarkets', async (_req: Request, res: Response) => {
  const { data, error } = await db
    .from('supermarkets')
    .select('id, name, cadena_display_name, config')
    .eq('is_active', true);
  if (error) throw error;

  const list = ((data ?? []) as SupermarketRow[])
    .filter((s) => s.config?.instore?.enabled === true)
    .map((s) => ({
      id: s.id,
      name: s.name,
      display_name: s.cadena_display_name ?? s.name.toUpperCase(),
    }))
    .sort((a, b) => a.display_name.localeCompare(b.display_name, 'es'));

  res.json(success(list, { total: list.length }));
});

// =============================================================================
// GET /v1/in-store/lookup?ean=... — resolve a scanned barcode (read-only)
// =============================================================================
const LookupQuery = z.object({
  ean: z.string().trim().regex(/^\d{8,14}$/, 'EAN must be 8–14 digits'),
});

inStoreRouter.get('/lookup', async (req: Request, res: Response) => {
  const q = parseQuery(req, LookupQuery);
  const product = await resolveEan(q.ean);
  res.json(
    success({
      ean: q.ean,
      found: product !== null,
      product,
    }),
  );
});

// =============================================================================
// POST /v1/in-store/entries — submit a scanned price
// =============================================================================
const EntryBody = z.object({
  supermarket_id: z.string().trim().min(1),
  ean: z.string().trim().regex(/^\d{8,14}$/, 'EAN must be 8–14 digits'),
  price: z.number().positive(),
  list_price: z.number().positive().nullable().optional(),
  promo_price: z.number().positive().nullable().optional(),
  promo_text: z.string().trim().max(200).nullable().optional(),
  entered_by: z.string().trim().min(1).max(120),
  note: z.string().trim().max(1000).nullable().optional(),
});

inStoreRouter.post('/entries', async (req: Request, res: Response) => {
  const body = parseBody(req, EntryBody);
  try {
    const result = await recordInStoreEntry({
      supermarketId: body.supermarket_id,
      ean: body.ean,
      price: body.price,
      promoPrice: body.promo_price ?? null,
      promoText: body.promo_text ?? null,
      enteredBy: body.entered_by,
      note: body.note ?? null,
      apiKeyId: req.apiKey?.id ?? null,
    });
    res.status(201).json(
      success({
        entry_id: result.entryId,
        supermarket_id: result.supermarketId,
        ean: result.ean,
        product_id: result.productId,
        supermarket_product_id: result.supermarketProductId,
        snapshot_id: result.snapshotId,
        price: result.price,
        list_price: result.listPrice,
        promo_price: result.promoPrice,
        promo_text: result.promoText,
        entered_by: result.enteredBy,
        created_at: result.createdAt,
      }),
    );
  } catch (err) {
    if (err instanceof InStoreError) {
      if (err.kind === 'not_found') throw new ApiError('NOT_FOUND', err.message);
      throw ApiError.badRequest(err.message);
    }
    throw err;
  }
});

// =============================================================================
// GET /v1/in-store/entries — recent submissions (today's list / review)
// =============================================================================
const EntriesQuery = PaginationQuery.extend({
  supermarket_id: z.string().trim().min(1).optional(),
  date: z.iso.date().optional(),
  entered_by: z.string().trim().min(1).optional(),
});

interface EntryRow {
  id: string;
  supermarket_id: string;
  ean: string;
  product_id: string | null;
  price: number;
  list_price: number | null;
  promo_price: number | null;
  promo_text: string | null;
  entered_by: string;
  note: string | null;
  created_at: string;
  products: { name: string; brand: string | null } | null;
  supermarkets: { name: string; cadena_display_name: string | null } | null;
}

inStoreRouter.get('/entries', async (req: Request, res: Response) => {
  const q = parseQuery(req, EntriesQuery);
  const page = req.pagination?.page ?? q.page;
  const limit = req.pagination?.limit ?? q.limit;
  const offset = req.pagination?.offset ?? (page - 1) * limit;

  // Default to today (Buenos Aires) so "today's list" just works with no args.
  const date = q.date ?? todayInBuenosAires();
  const { fromUtc, toUtc } = baDayRangeUtc(date);

  let query = db
    .from('instore_price_entries')
    .select(
      'id, supermarket_id, ean, product_id, price, list_price, promo_price, promo_text, entered_by, note, created_at, products(name, brand), supermarkets(name, cadena_display_name)',
      { count: 'exact' },
    )
    .gte('created_at', fromUtc)
    .lt('created_at', toUtc)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (q.supermarket_id) query = query.eq('supermarket_id', q.supermarket_id);
  if (q.entered_by) query = query.eq('entered_by', q.entered_by);

  const { data, error, count } = await query;
  if (error) throw error;

  const items = ((data ?? []) as unknown as EntryRow[]).map((row) => ({
    id: row.id,
    supermarket_id: row.supermarket_id,
    supermarket_name: row.supermarkets?.cadena_display_name ?? row.supermarkets?.name ?? null,
    ean: row.ean,
    product_id: row.product_id,
    product_name: row.products?.name ?? null,
    brand: row.products?.brand ?? null,
    price: row.price,
    list_price: row.list_price,
    promo_price: row.promo_price,
    promo_text: row.promo_text,
    entered_by: row.entered_by,
    note: row.note,
    created_at: row.created_at,
  }));

  res.json(paginated(items, count ?? 0, page, limit));
});
