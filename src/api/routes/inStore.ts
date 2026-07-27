/**
 * In-store manual price-entry routes.
 *
 *   GET  /v1/in-store/supermarkets        chains to show in the store dropdown
 *   GET  /v1/in-store/lookup?ean=         resolve a scanned EAN to a catalog product
 *
 *   POST /v1/in-store/visits              start a PDV relevamiento (store + location)
 *   GET  /v1/in-store/visits              list visits (today by default)
 *   GET  /v1/in-store/visits/:id          one visit + entry/photo counts
 *   POST /v1/in-store/visits/:id/finish   save & close the visit (leave the PDV)
 *   POST /v1/in-store/visits/:id/photos   upload a flyer/offer photo (raw image body)
 *   GET  /v1/in-store/visits/:id/photos   list a visit's photos
 *
 *   POST /v1/in-store/entries             submit a scanned price (mapping + snapshot)
 *   GET  /v1/in-store/entries             recent submissions (today's list / review)
 *
 * These power a mobile web tool used by field workers in physical (mostly
 * wholesale) stores. Auth is the platform-standard X-API-Key; the app embeds a
 * key scoped to `in-store` (see enforceScopes). Contract + UX:
 * docs/IN_STORE_PRICE_ENTRY.md.
 */

import express, { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { db } from '../../shared/db.js';
import { ApiError } from '../lib/apiError.js';
import { paginated, success } from '../lib/envelope.js';
import { parseBody, parseQuery, PaginationQuery } from '../lib/parseQuery.js';
import { resolveEan, type ResolvedProduct } from '../../instore/resolve.js';
import { recordInStoreEntry, InStoreError } from '../../instore/entry.js';
import { createVisit, finishVisit, getVisit, countVisit, type Visit, type VisitCounts } from '../../instore/visits.js';
import { uploadVisitPhoto } from '../../instore/storage.js';
import { approveVisit, type ReviewDecision } from '../../instore/review.js';

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

/** Map an InStoreError to the matching HTTP error. */
function toApiError(err: unknown): never {
  if (err instanceof InStoreError) {
    if (err.kind === 'not_found') throw new ApiError('NOT_FOUND', err.message);
    throw ApiError.badRequest(err.message);
  }
  throw err;
}

/**
 * Review is a back-office action, not something the field app should do. The
 * app embeds a key scoped to `in-store`; require a FULL-ACCESS key (no scopes)
 * for the review endpoints so a leaked app key can't approve prices.
 */
function requireFullAccess(req: Request): void {
  const scopes = req.apiKey?.scopes;
  if (scopes && scopes.length > 0) {
    throw ApiError.forbidden('Review requires a full-access API key');
  }
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

/** Map the resolver's internal (camelCase) shape to the snake_case API contract. */
function toApiProduct(p: ResolvedProduct): Record<string, unknown> {
  return {
    product_id: p.productId,
    ean: p.ean,
    name: p.name,
    brand: p.brand,
    manufacturer: p.manufacturer,
    category: p.category,
    subcategory: p.subcategory,
    format: p.format,
    variety: p.variety,
    image_url: p.imageUrl,
    source: p.source,
  };
}

inStoreRouter.get('/lookup', async (req: Request, res: Response) => {
  const q = parseQuery(req, LookupQuery);
  const product = await resolveEan(q.ean);
  res.json(
    success({
      ean: q.ean,
      found: product !== null,
      product: product ? toApiProduct(product) : null,
    }),
  );
});

// =============================================================================
// Visits (PDV relevamientos)
// =============================================================================
function toApiVisit(v: Visit, counts?: VisitCounts): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: v.id,
    supermarket_id: v.supermarketId,
    provincia: v.provincia,
    localidad: v.localidad,
    direccion: v.direccion,
    entered_by: v.enteredBy,
    note: v.note,
    status: v.status,
    started_at: v.startedAt,
    finished_at: v.finishedAt,
  };
  if (counts) out.counts = counts;
  return out;
}

const VisitBody = z.object({
  supermarket_id: z.string().trim().min(1),
  provincia: z.string().trim().max(120).nullable().optional(),
  localidad: z.string().trim().max(120).nullable().optional(),
  direccion: z.string().trim().max(300).nullable().optional(),
  entered_by: z.string().trim().min(1).max(120),
  note: z.string().trim().max(1000).nullable().optional(),
});

// POST /v1/in-store/visits — start a relevamiento
inStoreRouter.post('/visits', async (req: Request, res: Response) => {
  const body = parseBody(req, VisitBody);
  try {
    const visit = await createVisit({
      supermarketId: body.supermarket_id,
      provincia: body.provincia ?? null,
      localidad: body.localidad ?? null,
      direccion: body.direccion ?? null,
      enteredBy: body.entered_by,
      note: body.note ?? null,
      apiKeyId: req.apiKey?.id ?? null,
    });
    res.status(201).json(success(toApiVisit(visit)));
  } catch (err) {
    toApiError(err);
  }
});

// GET /v1/in-store/visits — list visits (defaults to today)
const VisitsQuery = PaginationQuery.extend({
  supermarket_id: z.string().trim().min(1).optional(),
  date: z.iso.date().optional(),
  status: z.enum(['open', 'finished']).optional(),
  entered_by: z.string().trim().min(1).optional(),
});

interface VisitListRow {
  id: string;
  supermarket_id: string;
  provincia: string | null;
  localidad: string | null;
  direccion: string | null;
  entered_by: string;
  note: string | null;
  status: 'open' | 'finished';
  started_at: string;
  finished_at: string | null;
  supermarkets: { name: string; cadena_display_name: string | null } | null;
}

inStoreRouter.get('/visits', async (req: Request, res: Response) => {
  const q = parseQuery(req, VisitsQuery);
  const page = req.pagination?.page ?? q.page;
  const limit = req.pagination?.limit ?? q.limit;
  const offset = req.pagination?.offset ?? (page - 1) * limit;

  const date = q.date ?? todayInBuenosAires();
  const { fromUtc, toUtc } = baDayRangeUtc(date);

  let query = db
    .from('instore_visits')
    .select(
      'id, supermarket_id, provincia, localidad, direccion, entered_by, note, status, started_at, finished_at, supermarkets(name, cadena_display_name)',
      { count: 'exact' },
    )
    .gte('started_at', fromUtc)
    .lt('started_at', toUtc)
    .order('started_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (q.supermarket_id) query = query.eq('supermarket_id', q.supermarket_id);
  if (q.status) query = query.eq('status', q.status);
  if (q.entered_by) query = query.eq('entered_by', q.entered_by);

  const { data, error, count } = await query;
  if (error) throw error;

  const items = ((data ?? []) as unknown as VisitListRow[]).map((r) => ({
    id: r.id,
    supermarket_id: r.supermarket_id,
    supermarket_name: r.supermarkets?.cadena_display_name ?? r.supermarkets?.name ?? null,
    provincia: r.provincia,
    localidad: r.localidad,
    direccion: r.direccion,
    entered_by: r.entered_by,
    note: r.note,
    status: r.status,
    started_at: r.started_at,
    finished_at: r.finished_at,
  }));

  res.json(paginated(items, count ?? 0, page, limit));
});

// GET /v1/in-store/visits/:id — one visit + counts
inStoreRouter.get('/visits/:id', async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const visit = await getVisit(id);
  if (!visit) throw ApiError.notFound('Visit');
  const counts = await countVisit(id);
  res.json(success(toApiVisit(visit, counts)));
});

// POST /v1/in-store/visits/:id/finish — save & close the visit
inStoreRouter.post('/visits/:id/finish', async (req: Request, res: Response) => {
  const id = req.params.id as string;
  try {
    const { visit, counts } = await finishVisit(id);
    res.json(success(toApiVisit(visit, counts)));
  } catch (err) {
    toApiError(err);
  }
});

// POST /v1/in-store/visits/:id/photos — upload a flyer/offer photo (raw image body)
//
// The image is sent as the raw request body with an image/* Content-Type. The
// global JSON parser (application/json only) skips it, so express.raw here reads
// the bytes without the 64kb JSON cap. Optional `?caption=`.
const PhotoQuery = z.object({
  caption: z.string().trim().max(300).optional(),
});

inStoreRouter.post(
  '/visits/:id/photos',
  express.raw({ type: () => true, limit: '15mb' }),
  async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const q = parseQuery(req, PhotoQuery);

    const visit = await getVisit(id);
    if (!visit) throw ApiError.notFound('Visit');

    const buf = req.body as Buffer;
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      throw ApiError.badRequest('Empty image body — send the raw image bytes with an image/* Content-Type');
    }

    let uploaded;
    try {
      uploaded = await uploadVisitPhoto(id, buf);
    } catch (err) {
      throw ApiError.badRequest(err instanceof Error ? err.message : 'Photo upload failed');
    }

    const insert = await db
      .from('instore_photos')
      .insert({
        visit_id: id,
        supermarket_id: visit.supermarketId,
        url: uploaded.url,
        storage_path: uploaded.storagePath,
        caption: q.caption ?? null,
        entered_by: visit.enteredBy,
        api_key_id: req.apiKey?.id ?? null,
      })
      .select('id, visit_id, supermarket_id, url, caption, entered_by, created_at')
      .single();
    if (insert.error) throw insert.error;

    res.status(201).json(success(insert.data));
  },
);

// GET /v1/in-store/visits/:id/photos — list a visit's photos
inStoreRouter.get('/visits/:id/photos', async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const { data, error } = await db
    .from('instore_photos')
    .select('id, visit_id, supermarket_id, url, caption, entered_by, created_at')
    .eq('visit_id', id)
    .order('created_at', { ascending: false });
  if (error) throw error;
  res.json(success(data ?? [], { total: (data ?? []).length }));
});

// =============================================================================
// POST /v1/in-store/entries — submit a scanned price
// =============================================================================
const EntryBody = z
  .object({
    visit_id: z.string().uuid().optional(),
    supermarket_id: z.string().trim().min(1).optional(),
    ean: z.string().trim().regex(/^\d{8,14}$/, 'EAN must be 8–14 digits'),
    // Precio Regular (unitario)
    price: z.number().positive(),
    // Precio con oferta (precio mayorista)
    wholesale_price: z.number().positive().nullable().optional(),
    // A partir de cuántas unidades es precio mayorista
    wholesale_min_units: z.number().int().positive().nullable().optional(),
    entered_by: z.string().trim().min(1).max(120).optional(),
    // Observaciones
    note: z.string().trim().max(1000).nullable().optional(),
  })
  .refine((b) => b.visit_id != null || (b.supermarket_id != null && b.entered_by != null), {
    message: 'Provide visit_id, or both supermarket_id and entered_by',
  });

inStoreRouter.post('/entries', async (req: Request, res: Response) => {
  const body = parseBody(req, EntryBody);
  try {
    const result = await recordInStoreEntry({
      visitId: body.visit_id ?? null,
      supermarketId: body.supermarket_id,
      ean: body.ean,
      price: body.price,
      wholesalePrice: body.wholesale_price ?? null,
      wholesaleMinUnits: body.wholesale_min_units ?? null,
      enteredBy: body.entered_by,
      note: body.note ?? null,
      apiKeyId: req.apiKey?.id ?? null,
    });
    res.status(201).json(
      success({
        entry_id: result.entryId,
        visit_id: result.visitId,
        supermarket_id: result.supermarketId,
        ean: result.ean,
        product_id: result.productId,
        product_name: result.productName,
        price: result.price,
        wholesale_price: result.wholesalePrice,
        wholesale_min_units: result.wholesaleMinUnits,
        note: result.note,
        entered_by: result.enteredBy,
        review_status: result.reviewStatus,
        created_at: result.createdAt,
      }),
    );
  } catch (err) {
    toApiError(err);
  }
});

// =============================================================================
// GET /v1/in-store/entries — recent submissions (today's list / review)
// =============================================================================
const EntriesQuery = PaginationQuery.extend({
  supermarket_id: z.string().trim().min(1).optional(),
  visit_id: z.string().uuid().optional(),
  date: z.iso.date().optional(),
  entered_by: z.string().trim().min(1).optional(),
  review_status: z.enum(['pending', 'approved', 'rejected']).optional(),
});

interface EntryRow {
  id: string;
  visit_id: string | null;
  supermarket_id: string;
  ean: string;
  product_id: string | null;
  product_name: string | null;
  price: number;
  promo_price: number | null;
  promo_min_units: number | null;
  note: string | null;
  entered_by: string;
  review_status: string;
  created_at: string;
  products: { name: string; brand: string | null } | null;
  supermarkets: { name: string; cadena_display_name: string | null } | null;
}

inStoreRouter.get('/entries', async (req: Request, res: Response) => {
  const q = parseQuery(req, EntriesQuery);
  const page = req.pagination?.page ?? q.page;
  const limit = req.pagination?.limit ?? q.limit;
  const offset = req.pagination?.offset ?? (page - 1) * limit;

  let query = db
    .from('instore_price_entries')
    .select(
      'id, visit_id, supermarket_id, ean, product_id, product_name, price, promo_price, promo_min_units, note, entered_by, review_status, created_at, products(name, brand), supermarkets(name, cadena_display_name)',
      { count: 'exact' },
    )
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  // A visit spans its own timeline — when scoping to one, show ALL its entries
  // regardless of day. Otherwise default to today (Buenos Aires).
  if (q.visit_id) {
    query = query.eq('visit_id', q.visit_id);
  } else {
    const { fromUtc, toUtc } = baDayRangeUtc(q.date ?? todayInBuenosAires());
    query = query.gte('created_at', fromUtc).lt('created_at', toUtc);
  }
  if (q.supermarket_id) query = query.eq('supermarket_id', q.supermarket_id);
  if (q.entered_by) query = query.eq('entered_by', q.entered_by);
  if (q.review_status) query = query.eq('review_status', q.review_status);

  const { data, error, count } = await query;
  if (error) throw error;

  const items = ((data ?? []) as unknown as EntryRow[]).map((row) => ({
    id: row.id,
    visit_id: row.visit_id,
    supermarket_id: row.supermarket_id,
    supermarket_name: row.supermarkets?.cadena_display_name ?? row.supermarkets?.name ?? null,
    ean: row.ean,
    product_id: row.product_id,
    product_name: row.products?.name ?? row.product_name ?? null,
    brand: row.products?.brand ?? null,
    price: row.price,
    wholesale_price: row.promo_price,
    wholesale_min_units: row.promo_min_units,
    note: row.note,
    entered_by: row.entered_by,
    review_status: row.review_status,
    created_at: row.created_at,
  }));

  res.json(paginated(items, count ?? 0, page, limit));
});

// =============================================================================
// Daily review (back-office) — requires a full-access API key
// =============================================================================

// GET /v1/in-store/review/pending — finished visits awaiting review.
const ReviewPendingQuery = PaginationQuery.extend({
  supermarket_id: z.string().trim().min(1).optional(),
});

interface ReviewVisitRow {
  id: string;
  supermarket_id: string;
  provincia: string | null;
  localidad: string | null;
  direccion: string | null;
  entered_by: string;
  note: string | null;
  status: 'open' | 'finished';
  review_status: string;
  started_at: string;
  finished_at: string | null;
  supermarkets: { name: string; cadena_display_name: string | null } | null;
}

inStoreRouter.get('/review/pending', async (req: Request, res: Response) => {
  requireFullAccess(req);
  const q = parseQuery(req, ReviewPendingQuery);
  const page = req.pagination?.page ?? q.page;
  const limit = req.pagination?.limit ?? q.limit;
  const offset = req.pagination?.offset ?? (page - 1) * limit;

  let query = db
    .from('instore_visits')
    .select(
      'id, supermarket_id, provincia, localidad, direccion, entered_by, note, status, review_status, started_at, finished_at, supermarkets(name, cadena_display_name)',
      { count: 'exact' },
    )
    .eq('status', 'finished')
    .eq('review_status', 'pending')
    .order('finished_at', { ascending: true, nullsFirst: false })
    .range(offset, offset + limit - 1);
  if (q.supermarket_id) query = query.eq('supermarket_id', q.supermarket_id);

  const { data, error, count } = await query;
  if (error) throw error;

  const visits = (data ?? []) as unknown as ReviewVisitRow[];

  // Pending-entry tally per visit (one query, grouped in JS).
  const ids = visits.map((v) => v.id);
  const pendingByVisit = new Map<string, number>();
  if (ids.length > 0) {
    const pend = await db
      .from('instore_price_entries')
      .select('visit_id')
      .in('visit_id', ids)
      .eq('review_status', 'pending');
    if (pend.error) throw pend.error;
    for (const row of pend.data ?? []) {
      const vid = row.visit_id as string;
      pendingByVisit.set(vid, (pendingByVisit.get(vid) ?? 0) + 1);
    }
  }

  const items = visits.map((v) => ({
    id: v.id,
    supermarket_id: v.supermarket_id,
    supermarket_name: v.supermarkets?.cadena_display_name ?? v.supermarkets?.name ?? null,
    provincia: v.provincia,
    localidad: v.localidad,
    direccion: v.direccion,
    entered_by: v.entered_by,
    note: v.note,
    status: v.status,
    review_status: v.review_status,
    started_at: v.started_at,
    finished_at: v.finished_at,
    pending_entries: pendingByVisit.get(v.id) ?? 0,
  }));

  res.json(paginated(items, count ?? 0, page, limit));
});

// GET /v1/in-store/review/visits/:id — one visit + all its entries for review.
interface ReviewEntryRow {
  id: string;
  ean: string;
  product_id: string | null;
  product_name: string | null;
  price: number;
  promo_price: number | null;
  promo_min_units: number | null;
  note: string | null;
  review_status: string;
  created_at: string;
  products: { name: string; brand: string | null; metadata: { imageUrl?: string | null } | null } | null;
}

inStoreRouter.get('/review/visits/:id', async (req: Request, res: Response) => {
  requireFullAccess(req);
  const id = req.params.id as string;
  const visit = await getVisit(id);
  if (!visit) throw ApiError.notFound('Visit');

  const entriesRes = await db
    .from('instore_price_entries')
    .select(
      'id, ean, product_id, product_name, price, promo_price, promo_min_units, note, review_status, created_at, products(name, brand, metadata)',
      { count: 'exact' },
    )
    .eq('visit_id', id)
    .order('created_at', { ascending: true });
  if (entriesRes.error) throw entriesRes.error;

  const entries = ((entriesRes.data ?? []) as unknown as ReviewEntryRow[]).map((e) => ({
    id: e.id,
    ean: e.ean,
    product_id: e.product_id,
    product_name: e.products?.name ?? e.product_name ?? null,
    brand: e.products?.brand ?? null,
    image_url: e.products?.metadata?.imageUrl ?? null,
    price: e.price,
    wholesale_price: e.promo_price,
    wholesale_min_units: e.promo_min_units,
    note: e.note,
    review_status: e.review_status,
    created_at: e.created_at,
  }));

  res.json(success({ visit: toApiVisit(visit), entries }));
});

// POST /v1/in-store/review/visits/:id/approve — approve (with inline edits/rejects).
const ApproveBody = z.object({
  reviewed_by: z.string().trim().min(1).max(200),
  decisions: z
    .array(
      z.object({
        entry_id: z.string().uuid(),
        action: z.enum(['approve', 'reject']),
        price: z.number().positive().optional(),
        wholesale_price: z.number().positive().nullable().optional(),
        wholesale_min_units: z.number().int().positive().nullable().optional(),
        note: z.string().trim().max(1000).nullable().optional(),
      }),
    )
    .optional(),
});

inStoreRouter.post('/review/visits/:id/approve', async (req: Request, res: Response) => {
  requireFullAccess(req);
  const id = req.params.id as string;
  const body = parseBody(req, ApproveBody);

  const decisions: ReviewDecision[] | undefined = body.decisions?.map((d) => ({
    entryId: d.entry_id,
    action: d.action,
    price: d.price,
    wholesalePrice: d.wholesale_price,
    wholesaleMinUnits: d.wholesale_min_units,
    note: d.note,
  }));

  try {
    const result = await approveVisit(id, { reviewedBy: body.reviewed_by, decisions });
    res.json(
      success({
        visit_id: result.visitId,
        approved: result.approved,
        rejected: result.rejected,
        snapshots: result.snapshots,
      }),
    );
  } catch (err) {
    toApiError(err);
  }
});
