/**
 * Bank / card promotions API (/v1/promos/*).
 *
 * A SEPARATE, isolated surface from the supermarket price API. It is reachable
 * ONLY with a `promos`-scoped API key:
 *   - `enforceScopes` (global) keeps a promos-scoped key OUT of every other
 *     /v1 route, and
 *   - `requirePromosScope` (below) keeps the existing full-access client key
 *     OUT of /v1/promos/*.
 * Net effect: the promotions data never reaches the supermarket-pricing client.
 *
 * Endpoints:
 *   GET /v1/promos            — paginated, filterable list of promotions
 *   GET /v1/promos/providers  — providers + active counts + last run time
 *   GET /v1/promos/filters    — taxonomy for building the dashboard filter UI
 *   GET /v1/promos/:id        — one promotion (full detail incl. plans)
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { db } from '../../shared/db.js';
import { ApiError } from '../lib/apiError.js';
import { success, paginated } from '../lib/envelope.js';
import { parseQuery, PaginationQuery } from '../lib/parseQuery.js';

export const promosRouter = Router();

/**
 * Guard: only a key whose scopes include 'promos' may touch these routes.
 * This is the INVERSE of the in-store `requireFullAccess` guard — here a
 * full-access key (scopes null/empty, e.g. the supermarket client) is rejected.
 */
function requirePromosScope(req: Request): void {
  const scopes = req.apiKey?.scopes;
  if (!scopes || !scopes.includes('promos')) {
    throw ApiError.forbidden('This endpoint requires a promos-scoped API key');
  }
}

promosRouter.use((req, _res, next) => {
  try {
    requirePromosScope(req);
    next();
  } catch (err) {
    next(err);
  }
});

// Columns returned in list responses (raw payload omitted to keep it small).
const LIST_COLUMNS =
  'id, provider_id, external_id, title, merchant, category, category_name, ' +
  'subcategory, subtitle, payment_methods, weekdays, purchase_modes, ' +
  'max_discount_pct, max_installments, valid_from, valid_to, url, full_url, ' +
  'logo_url, image_url, is_featured, is_active, tags, first_seen, last_seen';

// Detail adds the per-plan breakdown.
const DETAIL_COLUMNS = `${LIST_COLUMNS}, plans, raw`;

// Fixed taxonomy enums (stable across providers) surfaced by /filters.
const PAYMENT_METHODS = ['CREDITO', 'DEBITO', 'DINERO', 'VISA', 'MASTER', 'AMEX'];
const WEEKDAYS = [
  'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY', 'ALL_DAYS',
];
const PURCHASE_MODES = ['ONLINE', 'IN_STORE'];

// ---- GET /v1/promos (list) ----------------------------------------------------

const ListQuery = z
  .object({
    provider: z.string().trim().min(1).optional(),
    category: z.string().trim().min(1).optional(),
    paymentMethod: z.string().trim().min(1).optional(),
    weekday: z.string().trim().min(1).optional(),
    purchaseMode: z.string().trim().min(1).optional(),
    merchant: z.string().trim().min(1).optional(),
    minDiscount: z.coerce.number().int().min(0).max(100).optional(),
    featured: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => (v === undefined ? undefined : v === 'true')),
    activeOnly: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
  })
  .merge(PaginationQuery);

promosRouter.get('/', async (req: Request, res: Response) => {
  const q = parseQuery(req, ListQuery);
  const offset = (q.page - 1) * q.limit;

  let query = db
    .from('promotions')
    .select(LIST_COLUMNS, { count: 'exact' });

  if (q.activeOnly) query = query.eq('is_active', true);
  if (q.provider) query = query.eq('provider_id', q.provider);
  if (q.category) query = query.eq('category', q.category.toUpperCase());
  if (q.paymentMethod) query = query.contains('payment_methods', [q.paymentMethod.toUpperCase()]);
  if (q.weekday) query = query.contains('weekdays', [q.weekday.toUpperCase()]);
  if (q.purchaseMode) query = query.contains('purchase_modes', [q.purchaseMode.toUpperCase()]);
  if (q.minDiscount != null) query = query.gte('max_discount_pct', q.minDiscount);
  if (q.merchant) query = query.ilike('merchant', `%${q.merchant}%`);
  if (q.featured != null) query = query.eq('is_featured', q.featured);

  query = query
    .order('is_featured', { ascending: false })
    .order('max_discount_pct', { ascending: false, nullsFirst: false })
    .order('merchant', { ascending: true })
    .range(offset, offset + q.limit - 1);

  const { data, error, count } = await query;
  if (error) throw error;

  res.json(paginated(data ?? [], count ?? 0, q.page, q.limit));
});

// ---- GET /v1/promos/providers -------------------------------------------------
// Defined before /:id so "providers" isn't captured as an id.

promosRouter.get('/providers', async (_req: Request, res: Response) => {
  const { data, error } = await db
    .from('promo_providers')
    .select('id, name, base_url, active, last_run_at')
    .order('name', { ascending: true });
  if (error) throw error;

  const providers = await Promise.all(
    (data ?? []).map(async (p) => {
      const { count } = await db
        .from('promotions')
        .select('id', { count: 'exact', head: true })
        .eq('provider_id', p.id)
        .eq('is_active', true);
      return {
        id: p.id,
        name: p.name,
        baseUrl: p.base_url,
        active: p.active,
        lastRunAt: p.last_run_at,
        activePromotions: count ?? 0,
      };
    }),
  );

  res.json(success(providers, { total: providers.length }));
});

// ---- GET /v1/promos/filters ---------------------------------------------------

promosRouter.get('/filters', async (_req: Request, res: Response) => {
  // Dynamic categories (from what we actually store); fixed enums for the rest.
  const { data, error } = await db
    .from('promotions')
    .select('category, category_name')
    .eq('is_active', true)
    .not('category', 'is', null);
  if (error) throw error;

  const seen = new Map<string, string | null>();
  for (const r of data ?? []) {
    const key = r.category as string;
    if (!seen.has(key)) seen.set(key, (r.category_name as string | null) ?? null);
  }
  const categories = [...seen.entries()]
    .map(([key, name]) => ({ key, name }))
    .sort((a, b) => (a.name ?? a.key).localeCompare(b.name ?? b.key));

  const { data: provs } = await db
    .from('promo_providers')
    .select('id, name')
    .eq('active', true)
    .order('name', { ascending: true });

  res.json(
    success({
      providers: (provs ?? []).map((p) => ({ id: p.id, name: p.name })),
      categories,
      paymentMethods: PAYMENT_METHODS,
      weekdays: WEEKDAYS,
      purchaseModes: PURCHASE_MODES,
    }),
  );
});

// ---- GET /v1/promos/:id -------------------------------------------------------

promosRouter.get('/:id', async (req: Request, res: Response) => {
  const id = req.params.id;
  const { data, error } = await db
    .from('promotions')
    .select(DETAIL_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw ApiError.notFound('Promotion');

  res.json(success(data));
});
