/**
 * Revista (magazine) review routes.
 *
 *   GET  /v1/revistas/pending                  magazines awaiting review (modal/badge)
 *   GET  /v1/revistas/:magazineId              one magazine header + counts
 *   GET  /v1/revistas/:magazineId/items        the review queue (paginated)
 *   POST /v1/revistas/items/:itemId/approve    approve → mapping + snapshot
 *   POST /v1/revistas/items/:itemId/reject     reject (discard)
 *   POST /v1/revistas/:magazineId/items        manually add a missed product
 *   POST /v1/revistas/:magazineId/finalize     mark magazine reviewed
 *
 * Contract: docs/REVISTA_REVIEW.md. Auth + envelope are the platform standard.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { db, fetchInChunks } from '../../shared/db.js';
import { logger } from '../../shared/logger.js';
import {
  approveReviewItem,
  addManualItem,
  ItemError,
  type ApproveResult,
} from '../../revistas/approve.js';
import { ApiError } from '../lib/apiError.js';
import { paginated, success } from '../lib/envelope.js';
import { parseBody, parseQuery, PaginationQuery } from '../lib/parseQuery.js';

export const revistasRouter = Router();

// =============================================================================
// Shared shapes
// =============================================================================
interface MagazineRow {
  id: string;
  supermarket_id: string;
  label: string;
  scrape_run_id: string | null;
  source_strategy: string;
  source_url: string;
  page_count: number;
  status: string;
  detected_at: string;
}

interface Counts {
  total: number;
  pending: number;
  approved: number;
  rejected: number;
}

/** Tally review-item statuses for a magazine in a single query. */
async function countsFor(magazineId: string): Promise<Counts> {
  const { data, error } = await db
    .from('revista_review_items')
    .select('status')
    .eq('magazine_id', magazineId);
  if (error) throw error;
  const counts: Counts = { total: 0, pending: 0, approved: 0, rejected: 0 };
  for (const row of data ?? []) {
    counts.total++;
    const s = row.status as keyof Counts;
    if (s === 'pending' || s === 'approved' || s === 'rejected') counts[s]++;
  }
  return counts;
}

/** Map a magazine row + counts + supermarket name into the API shape. */
function magazineResponse(m: MagazineRow, supermarketName: string, counts: Counts): object {
  return {
    id: m.id,
    supermarket_id: m.supermarket_id,
    supermarket_name: supermarketName,
    label: m.label,
    scrape_run_id: m.scrape_run_id,
    source_strategy: m.source_strategy,
    source_url: m.source_url,
    page_count: m.page_count,
    status: m.status,
    counts,
    detected_at: m.detected_at,
  };
}

const MAGAZINE_COLS =
  'id, supermarket_id, label, scrape_run_id, source_strategy, source_url, page_count, status, detected_at';

async function loadMagazine(id: string): Promise<MagazineRow> {
  const { data, error } = await db
    .from('revista_magazines')
    .select(MAGAZINE_COLS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw ApiError.notFound('Magazine');
  return data as MagazineRow;
}

async function supermarketName(id: string): Promise<string> {
  const { data } = await db.from('supermarkets').select('name').eq('id', id).maybeSingle();
  return (data?.name as string) ?? id;
}

// =============================================================================
// GET /v1/revistas
//
// List ALL magazines (any status) — powers the debug/analyze view. Unlike
// /pending (which is only `in_review`), this shows `processing` (crashed /
// still running) and `reviewed` too, so an operator can see everything the
// pipeline has ever detected. Optional ?status filter.
// =============================================================================
const ListQuery = z.object({
  status: z.enum(['processing', 'in_review', 'reviewed']).optional(),
  supermarket_id: z.string().trim().min(1).optional(),
});

revistasRouter.get('/', async (req: Request, res: Response) => {
  const q = parseQuery(req, ListQuery);
  let query = db
    .from('revista_magazines')
    .select(MAGAZINE_COLS)
    .order('detected_at', { ascending: false });
  if (q.status) query = query.eq('status', q.status);
  if (q.supermarket_id) query = query.eq('supermarket_id', q.supermarket_id);

  const { data, error } = await query;
  if (error) throw error;
  const magazines = (data ?? []) as MagazineRow[];

  const smIds = [...new Set(magazines.map((m) => m.supermarket_id))];
  const names = new Map<string, string>();
  if (smIds.length > 0) {
    const { data: sms } = await db.from('supermarkets').select('id, name').in('id', smIds);
    for (const s of sms ?? []) names.set(s.id as string, s.name as string);
  }

  const out = await Promise.all(
    magazines.map(async (m) =>
      magazineResponse(m, names.get(m.supermarket_id) ?? m.supermarket_id, await countsFor(m.id)),
    ),
  );
  res.json(success(out));
});

// =============================================================================
// GET /v1/revistas/pending
// =============================================================================
revistasRouter.get('/pending', async (_req: Request, res: Response) => {
  const { data, error } = await db
    .from('revista_magazines')
    .select(MAGAZINE_COLS)
    .eq('status', 'in_review')
    .order('detected_at', { ascending: false });
  if (error) throw error;
  const magazines = (data ?? []) as MagazineRow[];

  // Resolve supermarket names in one trip.
  const smIds = [...new Set(magazines.map((m) => m.supermarket_id))];
  const names = new Map<string, string>();
  if (smIds.length > 0) {
    const { data: sms } = await db.from('supermarkets').select('id, name').in('id', smIds);
    for (const s of sms ?? []) names.set(s.id as string, s.name as string);
  }

  const out = await Promise.all(
    magazines.map(async (m) =>
      magazineResponse(m, names.get(m.supermarket_id) ?? m.supermarket_id, await countsFor(m.id)),
    ),
  );
  res.json(success(out));
});

// =============================================================================
// GET /v1/revistas/:magazineId
// =============================================================================
revistasRouter.get('/:magazineId', async (req: Request, res: Response) => {
  const magazineId = req.params.magazineId as string;
  const m = await loadMagazine(magazineId);
  res.json(success(magazineResponse(m, await supermarketName(m.supermarket_id), await countsFor(m.id))));
});

// =============================================================================
// GET /v1/revistas/:magazineId/analysis
//
// Debug/analyze payload: the full-magazine page images + EVERYTHING the AI read
// per page (matched or not) with the match reason. This is what lets an operator
// (a) see the actual PDF pages and (b) understand why items did/didn't match —
// the answer to "why is `matched` 0?". Data comes from revista_magazines.metadata,
// populated by the pipeline.
// =============================================================================
interface MagazineMetadata {
  matched?: number;
  total?: number;
  page_images?: Array<{ page: number; url: string }>;
  analysis?: Array<{
    page: number;
    extracted: Record<string, unknown>;
    matched: boolean;
    method: string;
    confidence: number;
    reason: string;
    matched_product_id: string | null;
    top_candidates: Array<{ id: string; name: string | null; brand: string | null }>;
  }>;
}

revistasRouter.get('/:magazineId/analysis', async (req: Request, res: Response) => {
  const magazineId = req.params.magazineId as string;
  const { data, error } = await db
    .from('revista_magazines')
    .select(`${MAGAZINE_COLS}, metadata`)
    .eq('id', magazineId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw ApiError.notFound('Magazine');

  const m = data as MagazineRow;
  const meta = (data.metadata ?? {}) as MagazineMetadata;
  res.json(
    success({
      magazine: magazineResponse(m, await supermarketName(m.supermarket_id), await countsFor(m.id)),
      page_images: meta.page_images ?? [],
      extracted_total: meta.total ?? 0,
      matched_total: meta.matched ?? 0,
      analysis: meta.analysis ?? [],
    }),
  );
});

// =============================================================================
// GET /v1/revistas/:magazineId/items
// =============================================================================
interface ProductRow {
  id: string;
  name: string | null;
  brand: string | null;
  ean: string | null;
  unit: string | null;
  format: string | null;
}

const ItemsQuery = PaginationQuery.extend({
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
  page_number: z.coerce.number().int().positive().optional(),
});

revistasRouter.get('/:magazineId/items', async (req: Request, res: Response) => {
  const magazineId = req.params.magazineId as string;
  await loadMagazine(magazineId); // 404 if missing
  const q = parseQuery(req, ItemsQuery);
  const page = req.pagination?.page ?? q.page;
  const limit = req.pagination?.limit ?? q.limit;
  const offset = req.pagination?.offset ?? (page - 1) * limit;

  let query = db
    .from('revista_review_items')
    .select(
      'id, magazine_id, supermarket_id, page_number, page_image_url, extracted, proposed_product_id, confidence, method, reason, candidates, status, reviewed_by, reviewed_at',
      { count: 'exact' },
    )
    .eq('magazine_id', magazineId)
    .order('page_number', { ascending: true })
    .order('created_at', { ascending: true })
    .range(offset, offset + limit - 1);
  if (q.status) query = query.eq('status', q.status);
  if (q.page_number) query = query.eq('page_number', q.page_number);

  const { data, error, count } = await query;
  if (error) throw error;
  const items = data ?? [];

  // Resolve the proposed-match product details in one batched read.
  const productIds = [
    ...new Set(items.map((i) => i.proposed_product_id).filter((id): id is string => Boolean(id))),
  ];
  const products = new Map<string, ProductRow>();
  if (productIds.length > 0) {
    const rows = await fetchInChunks<ProductRow>(productIds, (chunk) =>
      db.from('products').select('id, name, brand, ean, unit, format').in('id', chunk),
    );
    for (const p of rows) products.set(p.id, p);
  }

  const toMatch = (p: ProductRow | undefined): object | null =>
    p ? { product_id: p.id, name: p.name, brand: p.brand, ean: p.ean, quantity: p.unit ?? p.format ?? null } : null;

  const out = items.map((i) => ({
    id: i.id,
    magazine_id: i.magazine_id,
    supermarket_id: i.supermarket_id,
    page_number: i.page_number,
    page_image_url: i.page_image_url,
    extracted: i.extracted,
    proposed_match: i.proposed_product_id ? toMatch(products.get(i.proposed_product_id)) : null,
    confidence: typeof i.confidence === 'string' ? Number(i.confidence) : i.confidence,
    method: i.method,
    reason: i.reason,
    candidates: Array.isArray(i.candidates)
      ? (i.candidates as Array<Record<string, unknown>>).map((c) => ({
          product_id: c.id ?? c.product_id ?? null,
          name: c.name ?? null,
          brand: c.brand ?? null,
        }))
      : [],
    status: i.status,
    reviewed_by: i.reviewed_by,
    reviewed_at: i.reviewed_at,
  }));

  res.json(paginated(out, count ?? 0, page, limit));
});

// =============================================================================
// POST /v1/revistas/items/:itemId/approve
// =============================================================================
const ApproveBodySchema = z.object({
  product_id: z.string().uuid().optional(),
  price: z.number().nonnegative().optional(),
  promo_price: z.number().nonnegative().optional(),
  promo_text: z.string().max(500).optional(),
  note: z.string().max(1000).optional(),
  reviewed_by: z.string().max(200).optional(),
});

function approveResultResponse(r: ApproveResult): object {
  return {
    item_id: r.itemId,
    status: r.status,
    supermarket_product_id: r.supermarketProductId,
    snapshot_id: r.snapshotId,
    product_id: r.productId,
  };
}

/** Translate a domain ItemError into the matching ApiError. */
function mapItemError(err: unknown): never {
  if (err instanceof ItemError) {
    if (err.kind === 'not_found') throw ApiError.notFound('Review item');
    if (err.kind === 'conflict') throw ApiError.conflict(err.message);
    throw ApiError.badRequest(err.message);
  }
  throw err;
}

revistasRouter.post('/items/:itemId/approve', async (req: Request, res: Response) => {
  const body = parseBody(req, ApproveBodySchema);
  const itemId = req.params.itemId as string;
  try {
    const result = await approveReviewItem(itemId, {
      productId: body.product_id,
      price: body.price,
      promoPrice: body.promo_price,
      promoText: body.promo_text,
      note: body.note,
      reviewedBy: body.reviewed_by,
    });
    res.json(success(approveResultResponse(result)));
  } catch (err) {
    mapItemError(err);
  }
});

// =============================================================================
// POST /v1/revistas/items/:itemId/reject
// =============================================================================
const RejectBodySchema = z.object({
  note: z.string().max(1000).optional(),
  reviewed_by: z.string().max(200).optional(),
});

revistasRouter.post('/items/:itemId/reject', async (req: Request, res: Response) => {
  const body = parseBody(req, RejectBodySchema);
  const itemId = req.params.itemId as string;
  const existing = await db
    .from('revista_review_items')
    .select('id, status')
    .eq('id', itemId)
    .maybeSingle();
  if (existing.error) throw existing.error;
  if (!existing.data) throw ApiError.notFound('Review item');
  if (existing.data.status !== 'pending') {
    throw ApiError.conflict(`Item already ${existing.data.status}`);
  }

  const { error } = await db
    .from('revista_review_items')
    .update({
      status: 'rejected',
      note: body.note ?? null,
      reviewed_by: body.reviewed_by ?? null,
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', itemId);
  if (error) throw error;

  res.json(success({ item_id: itemId, status: 'rejected' }));
});

// =============================================================================
// POST /v1/revistas/:magazineId/items  — manually add a missed product
// =============================================================================
const ManualAddBodySchema = z.object({
  page_number: z.coerce.number().int().positive(),
  product_id: z.string().uuid(),
  price: z.number().nonnegative(),
  promo_price: z.number().nonnegative().optional(),
  promo_text: z.string().max(500).optional(),
  note: z.string().max(1000).optional(),
  reviewed_by: z.string().max(200).optional(),
});

revistasRouter.post('/:magazineId/items', async (req: Request, res: Response) => {
  const magazine = await loadMagazine(req.params.magazineId as string);
  const body = parseBody(req, ManualAddBodySchema);

  // Confirm the catalog product exists (catalog-only by design).
  const product = await db.from('products').select('id').eq('id', body.product_id).maybeSingle();
  if (product.error) throw product.error;
  if (!product.data) throw ApiError.badRequest('product_id does not reference an existing catalog product');

  // Reuse the page image of an existing item on the same page, if any.
  const sibling = await db
    .from('revista_review_items')
    .select('page_image_url')
    .eq('magazine_id', magazine.id)
    .eq('page_number', body.page_number)
    .not('page_image_url', 'is', null)
    .limit(1)
    .maybeSingle();
  const pageImageUrl = (sibling.data?.page_image_url as string | null) ?? null;

  try {
    const result = await addManualItem(magazine.id, magazine.supermarket_id, pageImageUrl, {
      pageNumber: body.page_number,
      productId: body.product_id,
      price: body.price,
      promoPrice: body.promo_price,
      promoText: body.promo_text,
      note: body.note,
      reviewedBy: body.reviewed_by,
    });
    res.status(201).json(success(approveResultResponse(result)));
  } catch (err) {
    mapItemError(err);
  }
});

// =============================================================================
// POST /v1/revistas/:magazineId/finalize
// =============================================================================
const FinalizeBodySchema = z.object({ force: z.boolean().optional() });

revistasRouter.post('/:magazineId/finalize', async (req: Request, res: Response) => {
  const magazine = await loadMagazine(req.params.magazineId as string);
  const body = parseBody(req, FinalizeBodySchema);
  const counts = await countsFor(magazine.id);

  if (counts.pending > 0 && !body.force) {
    throw ApiError.conflict(
      `Magazine still has ${counts.pending} pending item(s). Resolve them or pass force:true.`,
      { counts },
    );
  }

  const { error } = await db
    .from('revista_magazines')
    .update({ status: 'reviewed', reviewed_at: new Date().toISOString() })
    .eq('id', magazine.id);
  if (error) throw error;

  // Resolve the open revista_review alert for this magazine, if any.
  const { error: alertErr } = await db
    .from('alerts')
    .update({ status: 'resolved', resolved_at: new Date().toISOString() })
    .eq('type', 'revista_review')
    .eq('status', 'open')
    .contains('context', { magazine_id: magazine.id });
  if (alertErr) logger.warn({ err: alertErr, magazineId: magazine.id }, 'revista: could not resolve alert');

  res.json(
    success({
      magazine_id: magazine.id,
      status: 'reviewed',
      approved: counts.approved,
      rejected: counts.rejected,
      pending: counts.pending,
    }),
  );
});
