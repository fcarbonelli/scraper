/**
 * Revista (magazine) review routes.
 *
 *   GET    /v1/revistas/pending                  magazines awaiting review
 *   GET    /v1/revistas/checks                   daily probe log
 *   GET    /v1/revistas/items                    cross-magazine item list (control view)
 *   GET    /v1/revistas/ean-collisions           same-EAN / distinct-product warnings
 *   GET    /v1/revistas/duplicates               same-mapping / same-day snapshot dupes
 *   POST   /v1/revistas/duplicates/resolve       collapse one duplicate group
 *   GET    /v1/revistas/:magazineId              one magazine header + counts
 *   GET    /v1/revistas/:magazineId/items        per-magazine review queue
 *   GET    /v1/revistas/:magazineId/analysis     debug/analyze payload
 *   POST   /v1/revistas/items/:itemId/approve    approve → mapping + snapshot
 *   POST   /v1/revistas/items/:itemId/reject     reject (discard)
 *   PATCH  /v1/revistas/items/:itemId            edit an approved item
 *   DELETE /v1/revistas/items/:itemId            undo an approval → pending
 *   POST   /v1/revistas/:magazineId/items        manually add a missed product
 *   POST   /v1/revistas/:magazineId/finalize     mark magazine reviewed
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
  updateApprovedItem,
  undoApprovedItem,
  ItemError,
  type ApproveResult,
} from '../../revistas/approve.js';
import {
  findEanCollisions,
  buenosAiresDate,
  lastBaDays,
  isRevistaSnapshotSource,
  pickWinnerAmongDuplicates,
  losersAmongDuplicates,
  type DedupCandidate,
} from '../../revistas/pricing.js';
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
// GET /v1/revistas/checks
//
// The daily "did any magazine change?" probe log. One row per (chain, check),
// written whether or not a new issue was found — so the operator has evidence
// the check ran even on the (common) days nothing changed. Backed by
// revista_check_log (migration 009).
//
//   ?supermarket_id=makro   only one chain
//   ?latest=true            only the most-recent check per chain (dashboard view)
//   ?page/?limit            pagination (ignored when latest=true)
// =============================================================================
interface CheckLogRow {
  id: number;
  supermarket_id: string;
  strategy: string | null;
  checked_at: string;
  outcome: string;
  candidates: number;
  new_issues: number;
  duration_ms: number | null;
  detail: string | null;
  scrape_run_id: string | null;
}

const CHECK_COLS =
  'id, supermarket_id, strategy, checked_at, outcome, candidates, new_issues, duration_ms, detail, scrape_run_id';

const ChecksQuery = PaginationQuery.extend({
  supermarket_id: z.string().trim().min(1).optional(),
  // Note: z.coerce.boolean() treats "false" as true — parse the string explicitly.
  latest: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

function checkResponse(r: CheckLogRow, supermarketName: string): object {
  return {
    id: r.id,
    supermarket_id: r.supermarket_id,
    supermarket_name: supermarketName,
    strategy: r.strategy,
    checked_at: r.checked_at,
    outcome: r.outcome,
    candidates: r.candidates,
    new_issues: r.new_issues,
    duration_ms: r.duration_ms,
    detail: r.detail,
    scrape_run_id: r.scrape_run_id,
  };
}

revistasRouter.get('/checks', async (req: Request, res: Response) => {
  const q = parseQuery(req, ChecksQuery);

  // Latest-per-chain: fetch a recent window and keep the first (newest) row per
  // supermarket. Cheap — the log is one row per chain per day.
  if (q.latest) {
    let query = db
      .from('revista_check_log')
      .select(CHECK_COLS)
      .order('checked_at', { ascending: false })
      .limit(500);
    if (q.supermarket_id) query = query.eq('supermarket_id', q.supermarket_id);
    const { data, error } = await query;
    if (error) throw error;
    const rows = (data ?? []) as CheckLogRow[];

    const latestPerChain = new Map<string, CheckLogRow>();
    for (const r of rows) if (!latestPerChain.has(r.supermarket_id)) latestPerChain.set(r.supermarket_id, r);

    const smIds = [...latestPerChain.keys()];
    const names = new Map<string, string>();
    if (smIds.length > 0) {
      const { data: sms } = await db.from('supermarkets').select('id, name').in('id', smIds);
      for (const s of sms ?? []) names.set(s.id as string, s.name as string);
    }
    const out = [...latestPerChain.values()].map((r) =>
      checkResponse(r, names.get(r.supermarket_id) ?? r.supermarket_id),
    );
    res.json(success(out));
    return;
  }

  const page = req.pagination?.page ?? q.page;
  const limit = req.pagination?.limit ?? q.limit;
  const offset = req.pagination?.offset ?? (page - 1) * limit;

  let query = db
    .from('revista_check_log')
    .select(CHECK_COLS, { count: 'exact' })
    .order('checked_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (q.supermarket_id) query = query.eq('supermarket_id', q.supermarket_id);
  const { data, error, count } = await query;
  if (error) throw error;
  const rows = (data ?? []) as CheckLogRow[];

  const smIds = [...new Set(rows.map((r) => r.supermarket_id))];
  const names = new Map<string, string>();
  if (smIds.length > 0) {
    const { data: sms } = await db.from('supermarkets').select('id, name').in('id', smIds);
    for (const s of sms ?? []) names.set(s.id as string, s.name as string);
  }
  const out = rows.map((r) => checkResponse(r, names.get(r.supermarket_id) ?? r.supermarket_id));
  res.json(paginated(out, count ?? 0, page, limit));
});

// =============================================================================
// GET /v1/revistas/pending
//
// Drives the "nueva revista para revisar" banner in the Daily Review screen.
// Only magazines that actually have SOMETHING to review are returned — i.e.
// status='in_review' AND at least one pending item. Magazines where the AI
// matched nothing (very common: grocery folletos vs. our cleaning-focused
// catalog) or that are already fully approved/rejected would otherwise nag the
// operator with an empty queue. Those are still inspectable via GET /v1/revistas
// and the analysis view. Set ?include_empty=true to bypass the filter.
// =============================================================================
const PendingQuery = z.object({
  // Note: z.coerce.boolean() treats "false" as true — parse the string explicitly.
  include_empty: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

revistasRouter.get('/pending', async (req: Request, res: Response) => {
  const q = parseQuery(req, PendingQuery);
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

  const withCounts = await Promise.all(
    magazines.map(async (m) => ({ m, counts: await countsFor(m.id) })),
  );
  const out = withCounts
    .filter(({ counts }) => q.include_empty || counts.pending > 0)
    .map(({ m, counts }) =>
      magazineResponse(m, names.get(m.supermarket_id) ?? m.supermarket_id, counts),
    );
  res.json(success(out));
});

// =============================================================================
// GET /v1/revistas/items
//
// Cross-magazine review-item list (powers /revistas/aprobados + control Excel).
// MUST be registered before /:magazineId so "items" is not parsed as a UUID.
// Backed by revista_items_enriched (migration 013).
// =============================================================================
const AllItemsQuery = PaginationQuery.extend({
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
  supermarket_id: z.string().trim().min(1).optional(),
  search: z.string().trim().min(1).optional(),
});

interface EnrichedItemRow {
  id: string;
  magazine_id: string;
  supermarket_id: string;
  supermarket_name: string;
  magazine_label: string;
  source_url: string | null;
  page_number: number;
  page_image_url: string | null;
  extracted: Record<string, unknown> | null;
  approved_override: {
    price?: number | null;
    promo_price?: number | null;
    promo_text?: string | null;
  } | null;
  effective_price: number | null;
  effective_promo_price: number | null;
  effective_promo_text: string | null;
  proposed_product_id: string | null;
  match_name: string | null;
  match_brand: string | null;
  match_ean: string | null;
  match_quantity: string | null;
  confidence: number | string;
  method: string;
  reason: string | null;
  candidates: unknown;
  status: string;
  note: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
}

function enrichedItemResponse(i: EnrichedItemRow): object {
  // Effective extracted blob: AI read + operator override for list display.
  const extracted = { ...(i.extracted ?? {}) } as Record<string, unknown>;
  if (i.effective_price != null) extracted.price = Number(i.effective_price);
  if (i.effective_promo_price != null) extracted.promo_price = Number(i.effective_promo_price);
  else if (i.approved_override && 'promo_price' in i.approved_override) {
    extracted.promo_price = i.approved_override.promo_price;
  }
  if (i.effective_promo_text != null) extracted.promo_text = i.effective_promo_text;
  else if (i.approved_override && 'promo_text' in i.approved_override) {
    extracted.promo_text = i.approved_override.promo_text;
  }

  return {
    id: i.id,
    magazine_id: i.magazine_id,
    supermarket_id: i.supermarket_id,
    supermarket_name: i.supermarket_name,
    magazine_label: i.magazine_label,
    source_url: i.source_url,
    page_number: i.page_number,
    page_image_url: i.page_image_url,
    extracted,
    proposed_match: i.proposed_product_id
      ? {
          product_id: i.proposed_product_id,
          name: i.match_name,
          brand: i.match_brand,
          ean: i.match_ean,
          quantity: i.match_quantity,
        }
      : null,
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
    note: i.note,
    reviewed_by: i.reviewed_by,
    reviewed_at: i.reviewed_at,
  };
}

revistasRouter.get('/items', async (req: Request, res: Response) => {
  const q = parseQuery(req, AllItemsQuery);
  const page = req.pagination?.page ?? q.page;
  const limit = req.pagination?.limit ?? q.limit;
  const offset = req.pagination?.offset ?? (page - 1) * limit;

  let query = db
    .from('revista_items_enriched')
    .select('*', { count: 'exact' })
    .order('reviewed_at', { ascending: false, nullsFirst: false })
    .order('page_number', { ascending: true })
    .range(offset, offset + limit - 1);
  if (q.status) query = query.eq('status', q.status);
  if (q.supermarket_id) query = query.eq('supermarket_id', q.supermarket_id);
  if (q.search) query = query.ilike('search_text', `%${q.search.toLowerCase()}%`);

  const { data, error, count } = await query;
  if (error) throw error;
  const out = ((data ?? []) as EnrichedItemRow[]).map(enrichedItemResponse);
  res.json(paginated(out, count ?? 0, page, limit));
});

// =============================================================================
// GET /v1/revistas/ean-collisions
//
// Family-B warnings: same EAN + same chain + same day, distinct product_ids.
// Read-only — never deletes. Operators fix via rematch / EAN heal in the UI.
// =============================================================================
const CollisionsQuery = z.object({
  supermarket_id: z.string().trim().min(1).optional(),
  day: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

revistasRouter.get('/ean-collisions', async (req: Request, res: Response) => {
  const q = parseQuery(req, CollisionsQuery);
  const day = q.day ?? buenosAiresDate();

  // Active revista mappings → product EAN, then today's snapshots for those mappings.
  let mappingsQuery = db
    .from('supermarket_products')
    .select('id, supermarket_id, product_id, products!inner(ean, name), metadata')
    .eq('is_active', true)
    .eq('metadata->>source', 'revista');
  if (q.supermarket_id) mappingsQuery = mappingsQuery.eq('supermarket_id', q.supermarket_id);

  const { data: mappings, error: mapErr } = await mappingsQuery.limit(5000);
  if (mapErr) throw mapErr;

  type MappingRow = {
    id: string;
    supermarket_id: string;
    product_id: string;
    products: { ean: string | null; name: string | null };
  };
  const maps = (mappings ?? []) as unknown as MappingRow[];
  if (maps.length === 0) {
    res.json(success({ day, count: 0, collisions: [] }));
    return;
  }

  const spIds = maps.map((m) => m.id);
  const mapById = new Map(maps.map((m) => [m.id, m]));

  // Page snapshots for these mappings; filter to the requested BA day in JS
  // so we work before/after the scraped_on migration.
  const snapRows: Array<{
    id: number;
    supermarket_product_id: string;
    scraped_at: string;
    raw_data: { source?: string } | null;
  }> = [];
  const pageSize = 1000;
  for (let offset = 0; offset < spIds.length; offset += 200) {
    const chunk = spIds.slice(offset, offset + 200);
    let from = 0;
    for (;;) {
      // scraped_on only exists after migration 013 — derive the BA day from scraped_at.
      const { data, error } = await db
        .from('price_snapshots')
        .select('id, supermarket_product_id, scraped_at, raw_data')
        .in('supermarket_product_id', chunk)
        .is('scrape_run_id', null)
        .order('id', { ascending: true })
        .range(from, from + pageSize - 1);
      if (error) throw error;
      const batch = (data ?? []) as typeof snapRows;
      for (const row of batch) {
        const src = row.raw_data?.source;
        if (src && src !== 'revista' && src !== 'revista-carry-forward') continue;
        if (buenosAiresDate(new Date(row.scraped_at)) === day) snapRows.push(row);
      }
      if (batch.length < pageSize) break;
      from += pageSize;
    }
  }

  const collisionInput = snapRows.map((s) => {
    const m = mapById.get(s.supermarket_product_id);
    return {
      ean: m?.products.ean ?? '',
      supermarket_id: m?.supermarket_id ?? '',
      day,
      product_id: m?.product_id ?? '',
      name: m?.products.name ?? null,
      snapshot_id: s.id,
    };
  });

  const groups = findEanCollisions(collisionInput);
  res.json(
    success({
      day,
      count: groups.length,
      collisions: groups.map((g) => ({
        ean: g.ean,
        supermarket_id: g.supermarket_id,
        day: g.day,
        product_ids: g.product_ids,
        rows: g.rows.map((r) => ({
          product_id: r.product_id,
          name: r.name ?? null,
          snapshot_id: r.snapshot_id ?? null,
        })),
      })),
    }),
  );
});

// =============================================================================
// GET /v1/revistas/duplicates
//
// Family-A warnings: same mapping + same BA day with 2+ run-less revista
// snapshots. Default window = last 3 BA days (does not resurface old noise like
// a one-off Jul-14 batch). Operators resolve via POST /duplicates/resolve.
// =============================================================================
const DuplicatesQuery = z
  .object({
    supermarket_id: z.string().trim().min(1).optional(),
    day: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    days: z.coerce.number().int().min(1).max(90).optional(),
  })
  .refine((q) => !(q.day && q.days != null), {
    message: 'Use either day or days, not both',
  });

interface DupSnapRow extends DedupCandidate {
  id: number;
  supermarket_product_id: string;
  scraped_at: string;
  price: number | null;
  promotion_1: string | null;
  offer_price_1: number | null;
  raw_data: { source?: string } | null;
}

interface DupMappingRow {
  id: string;
  supermarket_id: string;
  product_id: string;
  products: { ean: string | null; name: string | null };
}

/** Load active revista mappings (optionally filtered by chain). */
async function loadRevistaMappingsForDupes(supermarketId?: string): Promise<DupMappingRow[]> {
  let q = db
    .from('supermarket_products')
    .select('id, supermarket_id, product_id, products!inner(ean, name), metadata')
    .eq('is_active', true)
    .eq('metadata->>source', 'revista');
  if (supermarketId) q = q.eq('supermarket_id', supermarketId);
  const { data, error } = await q.limit(10000);
  if (error) throw error;
  return (data ?? []) as unknown as DupMappingRow[];
}

/** Page run-less revista snapshots for the given mappings. */
async function loadRevistaSnapshotsForDupes(spIds: string[]): Promise<DupSnapRow[]> {
  const out: DupSnapRow[] = [];
  const pageSize = 1000;
  for (let offset = 0; offset < spIds.length; offset += 200) {
    const chunk = spIds.slice(offset, offset + 200);
    let from = 0;
    for (;;) {
      const { data, error } = await db
        .from('price_snapshots')
        .select(
          'id, supermarket_product_id, scraped_at, price, promotion_1, offer_price_1, raw_data',
        )
        .in('supermarket_product_id', chunk)
        .is('scrape_run_id', null)
        .order('id', { ascending: true })
        .range(from, from + pageSize - 1);
      if (error) throw error;
      const batch = (data ?? []) as DupSnapRow[];
      for (const row of batch) {
        const src = row.raw_data?.source;
        if (src && !isRevistaSnapshotSource(src)) continue;
        out.push(row);
      }
      if (batch.length < pageSize) break;
      from += pageSize;
    }
  }
  return out;
}

function snapDayBa(s: { scraped_at: string }): string {
  return buenosAiresDate(new Date(s.scraped_at));
}

function duplicateGroupResponse(
  spId: string,
  day: string,
  rows: DupSnapRow[],
  mapById: Map<string, DupMappingRow>,
): object {
  const info = mapById.get(spId);
  const winner = pickWinnerAmongDuplicates(rows);
  const losers = losersAmongDuplicates(rows);
  const snapShape = (r: DupSnapRow) => ({
    snapshot_id: r.id,
    price: r.price,
    promotion_1: r.promotion_1,
    offer_price_1: r.offer_price_1,
    scraped_at: r.scraped_at,
  });
  return {
    supermarket_product_id: spId,
    supermarket_id: info?.supermarket_id ?? null,
    product_id: info?.product_id ?? null,
    ean: info?.products.ean ?? null,
    name: info?.products.name ?? null,
    day,
    keep: winner ? snapShape(winner) : null,
    drop: losers.map(snapShape),
  };
}

revistasRouter.get('/duplicates', async (req: Request, res: Response) => {
  const q = parseQuery(req, DuplicatesQuery);
  const windowDays = q.day ? null : lastBaDays(q.days ?? 3);
  const dayAllowed = (day: string): boolean => {
    if (q.day) return day === q.day;
    return windowDays!.has(day);
  };

  const maps = await loadRevistaMappingsForDupes(q.supermarket_id);
  if (maps.length === 0) {
    res.json(
      success({
        days: q.day ? [q.day] : [...(windowDays ?? [])].sort(),
        count: 0,
        duplicates: [],
      }),
    );
    return;
  }

  const mapById = new Map(maps.map((m) => [m.id, m]));
  const snaps = await loadRevistaSnapshotsForDupes(maps.map((m) => m.id));

  const groups = new Map<string, DupSnapRow[]>();
  for (const s of snaps) {
    const day = snapDayBa(s);
    if (!dayAllowed(day)) continue;
    const key = `${s.supermarket_product_id}|${day}`;
    const list = groups.get(key) ?? [];
    list.push(s);
    groups.set(key, list);
  }

  const duplicates = [...groups.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([key, rows]) => {
      const [spId, day] = key.split('|') as [string, string];
      return duplicateGroupResponse(spId, day, rows, mapById);
    });

  res.json(
    success({
      days: q.day ? [q.day] : [...(windowDays ?? [])].sort(),
      count: duplicates.length,
      duplicates,
    }),
  );
});

// =============================================================================
// POST /v1/revistas/duplicates/resolve
//
// Collapse ONE duplicate group (mapping + BA day): keep the offer (else newest),
// delete the losers. One group per call — the control view clicks "resolver".
// =============================================================================
const ResolveDupBodySchema = z.object({
  supermarket_product_id: z.string().uuid(),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

revistasRouter.post('/duplicates/resolve', async (req: Request, res: Response) => {
  const body = parseBody(req, ResolveDupBodySchema);

  const mapping = await db
    .from('supermarket_products')
    .select('id, supermarket_id, product_id, metadata')
    .eq('id', body.supermarket_product_id)
    .maybeSingle();
  if (mapping.error) throw mapping.error;
  if (!mapping.data) throw ApiError.notFound('Supermarket product mapping');
  const meta = mapping.data.metadata as { source?: string } | null;
  if (meta?.source !== 'revista') {
    throw ApiError.badRequest('Mapping is not a revista-sourced product');
  }

  const snaps = await loadRevistaSnapshotsForDupes([body.supermarket_product_id]);
  const group = snaps.filter((s) => snapDayBa(s) === body.day);
  if (group.length < 2) {
    throw ApiError.conflict(
      `No duplicate group for mapping ${body.supermarket_product_id} on ${body.day} (found ${group.length} snapshot(s)).`,
    );
  }

  const winner = pickWinnerAmongDuplicates(group);
  const losers = losersAmongDuplicates(group);
  if (!winner || losers.length === 0) {
    throw ApiError.conflict('Could not pick a winner among duplicate snapshots');
  }

  const deleteIds = losers.map((l) => l.id as number);
  const { error: delErr } = await db.from('price_snapshots').delete().in('id', deleteIds);
  if (delErr) throw delErr;

  logger.info(
    {
      supermarketProductId: body.supermarket_product_id,
      day: body.day,
      kept: winner.id,
      deleted: deleteIds,
    },
    'revista: duplicate group resolved',
  );

  res.json(
    success({
      supermarket_product_id: body.supermarket_product_id,
      day: body.day,
      kept_snapshot_id: winner.id,
      deleted_snapshot_ids: deleteIds,
    }),
  );
});

// =============================================================================
// PATCH /v1/revistas/items/:itemId  — edit an approved item
// DELETE /v1/revistas/items/:itemId — undo approval → pending
// (Registered before /:magazineId so "items" is never a magazine id.)
// =============================================================================
const UpdateBodySchema = z
  .object({
    product_id: z.string().uuid().optional(),
    price: z.number().nonnegative().nullable().optional(),
    promo_price: z.number().nonnegative().nullable().optional(),
    promo_text: z.string().max(500).nullable().optional(),
    note: z.string().max(1000).nullable().optional(),
    reviewed_by: z.string().max(200).optional(),
  })
  .refine(
    (b) =>
      b.product_id !== undefined ||
      b.price !== undefined ||
      b.promo_price !== undefined ||
      b.promo_text !== undefined ||
      b.note !== undefined,
    { message: 'At least one field is required' },
  );

revistasRouter.patch('/items/:itemId', async (req: Request, res: Response) => {
  const body = parseBody(req, UpdateBodySchema);
  const itemId = req.params.itemId as string;
  try {
    const result = await updateApprovedItem(itemId, {
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

revistasRouter.delete('/items/:itemId', async (req: Request, res: Response) => {
  const itemId = req.params.itemId as string;
  try {
    const result = await undoApprovedItem(itemId);
    res.json(
      success({
        item_id: result.itemId,
        status: result.status,
        snapshot_deleted: result.snapshotDeleted,
      }),
    );
  } catch (err) {
    mapItemError(err);
  }
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
      'id, magazine_id, supermarket_id, page_number, page_image_url, extracted, approved_override, proposed_product_id, confidence, method, reason, candidates, status, reviewed_by, reviewed_at',
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

  const out = items.map((i) => {
    const extracted = { ...((i.extracted as Record<string, unknown> | null) ?? {}) };
    const override = i.approved_override as {
      price?: number | null;
      promo_price?: number | null;
      promo_text?: string | null;
    } | null;
    if (override) {
      if (override.price !== undefined) extracted.price = override.price;
      if ('promo_price' in override) extracted.promo_price = override.promo_price;
      if ('promo_text' in override) extracted.promo_text = override.promo_text;
    }
    return {
      id: i.id,
      magazine_id: i.magazine_id,
      supermarket_id: i.supermarket_id,
      page_number: i.page_number,
      page_image_url: i.page_image_url,
      extracted,
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
    };
  });

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
