/**
 * Supermarket routes.
 *
 *   GET  /v1/supermarkets               list with health + last_run_at
 *   GET  /v1/supermarkets/:id           single supermarket
 *   GET  /v1/supermarkets/:id/products  products mapped to this supermarket
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { db } from '../../shared/db.js';
import { ApiError } from '../lib/apiError.js';
import { paginated, success } from '../lib/envelope.js';
import { parseQuery, PaginationQuery } from '../lib/parseQuery.js';

export const supermarketsRouter = Router();

// =============================================================================
// GET /v1/supermarkets
// =============================================================================

supermarketsRouter.get('/', async (_req: Request, res: Response) => {
  const { data, error } = await db
    .from('supermarkets')
    .select('id, name, is_active, base_url, health_status, last_run_at, created_at')
    .order('name', { ascending: true });
  if (error) throw error;
  res.json(success(data ?? []));
});

// =============================================================================
// GET /v1/supermarkets/:id
// =============================================================================

supermarketsRouter.get('/:id', async (req: Request, res: Response) => {
  const { data, error } = await db
    .from('supermarkets')
    .select(
      'id, name, is_active, base_url, rate_limit_ms, concurrency, config, health_status, last_run_at, created_at',
    )
    .eq('id', req.params.id)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw ApiError.notFound('Supermarket');
  res.json(success(data));
});

// =============================================================================
// GET /v1/supermarkets/:id/products
//
// Returns supermarket_products for this supermarket, joined with the master
// product info, and the most recent snapshot for each.
// =============================================================================

const ListProductsQuery = PaginationQuery.extend({
  search: z.string().trim().min(1).max(200).optional(),
  in_stock: z.enum(['true', 'false']).optional(),
});

supermarketsRouter.get('/:id/products', async (req: Request, res: Response) => {
  const q = parseQuery(req, ListProductsQuery);
  const page = req.pagination?.page ?? q.page;
  const limit = req.pagination?.limit ?? q.limit;
  const offset = req.pagination?.offset ?? (page - 1) * limit;

  // Confirm supermarket exists
  const sm = await db
    .from('supermarkets')
    .select('id')
    .eq('id', req.params.id)
    .maybeSingle();
  if (sm.error) throw sm.error;
  if (!sm.data) throw ApiError.notFound('Supermarket');

  let mappingQuery = db
    .from('supermarket_products')
    .select(
      `id, external_id, external_url, is_active, created_at,
       products:product_id ( id, name, brand, category, unit, ean, metadata )`,
      { count: 'exact' },
    )
    .eq('supermarket_id', req.params.id)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  // Note: ilike on the joined table requires Supabase's foreign-table syntax.
  // We do the filter post-fetch for v1 to keep the query simple.

  const mappingsRes = await mappingQuery;
  if (mappingsRes.error) throw mappingsRes.error;
  let mappings = mappingsRes.data ?? [];

  // Post-filter by name search if requested
  if (q.search) {
    const needle = q.search.toLowerCase();
    mappings = mappings.filter((m) => {
      const p = Array.isArray(m.products) ? m.products[0] : m.products;
      return p?.name?.toLowerCase().includes(needle);
    });
  }

  // Fetch latest snapshot for each (in parallel)
  const items = await Promise.all(
    mappings.map(async (m) => {
      const snapRes = await db
        .from('price_snapshots')
        .select('price, in_stock, currency, scraped_at, promotions')
        .eq('supermarket_product_id', m.id)
        .order('scraped_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      const product = Array.isArray(m.products) ? m.products[0] : m.products;
      return {
        supermarket_product_id: m.id,
        external_id: m.external_id,
        external_url: m.external_url,
        product,
        latest_snapshot: snapRes.data ?? null,
      };
    }),
  );

  // Apply in_stock filter post-fetch (after we have snapshot data)
  const filtered =
    q.in_stock === undefined
      ? items
      : items.filter(
          (it) => Boolean(it.latest_snapshot?.in_stock) === (q.in_stock === 'true'),
        );

  res.json(paginated(filtered, mappingsRes.count ?? filtered.length, page, limit));
});
