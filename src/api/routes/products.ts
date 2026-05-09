/**
 * Product routes.
 *
 *   GET  /v1/products                  list with filters + pagination
 *   GET  /v1/products/:id              master product record
 *   GET  /v1/products/:id/compare      latest price across all supermarkets
 *   GET  /v1/products/:id/history      time series of price snapshots
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { db } from '../../shared/db.js';
import { ApiError } from '../lib/apiError.js';
import { paginated, success } from '../lib/envelope.js';
import { parseQuery, PaginationQuery } from '../lib/parseQuery.js';

export const productsRouter = Router();

// =============================================================================
// GET /v1/products
// =============================================================================

const ListQuery = PaginationQuery.extend({
  search: z.string().trim().min(1).max(200).optional(),
  category: z.string().trim().min(1).max(100).optional(),
  brand: z.string().trim().min(1).max(100).optional(),
});

productsRouter.get('/', async (req: Request, res: Response) => {
  const q = parseQuery(req, ListQuery);
  const page = req.pagination?.page ?? q.page;
  const limit = req.pagination?.limit ?? q.limit;
  const offset = req.pagination?.offset ?? (page - 1) * limit;

  let query = db
    .from('products')
    .select('id, name, category, brand, unit, ean, metadata, created_at, updated_at', {
      count: 'exact',
    })
    .order('name', { ascending: true })
    .range(offset, offset + limit - 1);

  if (q.search) query = query.ilike('name', `%${q.search}%`);
  if (q.category) query = query.eq('category', q.category);
  if (q.brand) query = query.eq('brand', q.brand);

  const { data, error, count } = await query;
  if (error) throw error;

  res.json(paginated(data ?? [], count ?? 0, page, limit));
});

// =============================================================================
// GET /v1/products/:id
// =============================================================================

productsRouter.get('/:id', async (req: Request, res: Response) => {
  const { data, error } = await db
    .from('products')
    .select('id, name, category, brand, unit, ean, metadata, created_at, updated_at')
    .eq('id', req.params.id)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw ApiError.notFound('Product');
  res.json(success(data));
});

// =============================================================================
// GET /v1/products/:id/compare
//
// Returns the latest snapshot at each supermarket for this product, plus
// summary stats (best price, worst price, avg).
// =============================================================================

productsRouter.get('/:id/compare', async (req: Request, res: Response) => {
  // 1. Confirm the product exists (404 vs returning [])
  const product = await db
    .from('products')
    .select('id, name')
    .eq('id', req.params.id)
    .maybeSingle();
  if (product.error) throw product.error;
  if (!product.data) throw ApiError.notFound('Product');

  // 2. Get all supermarket_products mappings for this product
  const mappingsRes = await db
    .from('supermarket_products')
    .select(
      `id, supermarket_id, external_id, external_url, is_active,
       supermarkets:supermarket_id ( id, name, health_status )`,
    )
    .eq('product_id', req.params.id)
    .eq('is_active', true);
  if (mappingsRes.error) throw mappingsRes.error;
  const mappings = mappingsRes.data ?? [];

  // 3. For each mapping, fetch the latest snapshot (1 round-trip per
  //    supermarket — fine for a typical N=30 supermarkets per product).
  const compares = await Promise.all(
    mappings.map(async (m) => {
      const snapRes = await db
        .from('price_snapshots')
        .select(
          'price, list_price, unit_price, unit_price_per, in_stock, currency, promotions, scraped_at',
        )
        .eq('supermarket_product_id', m.id)
        .order('scraped_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      const sm = Array.isArray(m.supermarkets) ? m.supermarkets[0] : m.supermarkets;
      return {
        supermarket_product_id: m.id,
        supermarket: sm
          ? { id: sm.id, name: sm.name, healthStatus: sm.health_status }
          : null,
        external_id: m.external_id,
        external_url: m.external_url,
        snapshot: snapRes.data ?? null,
      };
    }),
  );

  // 4. Compute summary
  const inStockPrices = compares
    .map((c) => c.snapshot?.price)
    .filter((p): p is number => typeof p === 'number');
  const summary =
    inStockPrices.length > 0
      ? {
          minPrice: Math.min(...inStockPrices),
          maxPrice: Math.max(...inStockPrices),
          avgPrice:
            Math.round(
              (inStockPrices.reduce((a, b) => a + b, 0) / inStockPrices.length) * 100,
            ) / 100,
          supermarketsCount: compares.length,
          inStockCount: compares.filter((c) => c.snapshot?.in_stock).length,
        }
      : null;

  res.json(
    success({
      product: product.data,
      summary,
      results: compares,
    }),
  );
});

// =============================================================================
// GET /v1/products/:id/history
//
// Time series of price snapshots. Filterable by date range and supermarket.
// =============================================================================

const HistoryQuery = PaginationQuery.extend({
  from: z.iso.date().optional(),     // YYYY-MM-DD
  to: z.iso.date().optional(),
  supermarket: z.string().trim().min(1).optional(),
});

productsRouter.get('/:id/history', async (req: Request, res: Response) => {
  const q = parseQuery(req, HistoryQuery);
  const page = req.pagination?.page ?? q.page;
  const limit = req.pagination?.limit ?? q.limit;
  const offset = req.pagination?.offset ?? (page - 1) * limit;

  // Get the supermarket_products ids for this product (optionally filtered)
  let mappingQuery = db
    .from('supermarket_products')
    .select('id, supermarket_id')
    .eq('product_id', req.params.id);
  if (q.supermarket) mappingQuery = mappingQuery.eq('supermarket_id', q.supermarket);

  const mappingsRes = await mappingQuery;
  if (mappingsRes.error) throw mappingsRes.error;
  const mappingIds = (mappingsRes.data ?? []).map((m) => m.id);
  if (mappingIds.length === 0) {
    res.json(paginated([], 0, page, limit));
    return;
  }

  let snapQuery = db
    .from('price_snapshots')
    .select(
      'id, supermarket_product_id, price, list_price, unit_price, unit_price_per, in_stock, currency, tier_used, promotions, scraped_at',
      { count: 'exact' },
    )
    .in('supermarket_product_id', mappingIds)
    .order('scraped_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (q.from) snapQuery = snapQuery.gte('scraped_at', `${q.from}T00:00:00Z`);
  if (q.to) snapQuery = snapQuery.lte('scraped_at', `${q.to}T23:59:59Z`);

  const { data, error, count } = await snapQuery;
  if (error) throw error;

  res.json(paginated(data ?? [], count ?? 0, page, limit));
});
