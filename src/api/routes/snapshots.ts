/**
 * Raw snapshot feed.
 *
 *   GET /v1/snapshots   filterable by supermarket, product, date range
 *
 * This is the lower-level endpoint for any consumer that wants to slice the
 * data themselves (e.g., analytics, ETL). For typical product views, prefer
 * /products/:id/history.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { db } from '../../shared/db.js';
import { paginated } from '../lib/envelope.js';
import { parseQuery, PaginationQuery } from '../lib/parseQuery.js';

export const snapshotsRouter = Router();

const ListQuery = PaginationQuery.extend({
  supermarket: z.string().trim().min(1).optional(),
  product: z.string().uuid().optional(),                 // master product id
  supermarket_product: z.string().uuid().optional(),     // mapping id
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  in_stock: z.enum(['true', 'false']).optional(),
});

snapshotsRouter.get('/', async (req: Request, res: Response) => {
  const q = parseQuery(req, ListQuery);
  const page = req.pagination?.page ?? q.page;
  const limit = req.pagination?.limit ?? q.limit;
  const offset = req.pagination?.offset ?? (page - 1) * limit;

  // If filtering by supermarket OR master product id, we first need the
  // matching supermarket_products ids — those are the FK in price_snapshots.
  let filterMappingIds: string[] | null = null;
  if (q.supermarket || q.product) {
    let mappingQuery = db.from('supermarket_products').select('id');
    if (q.supermarket) mappingQuery = mappingQuery.eq('supermarket_id', q.supermarket);
    if (q.product) mappingQuery = mappingQuery.eq('product_id', q.product);
    const mappingsRes = await mappingQuery;
    if (mappingsRes.error) throw mappingsRes.error;
    filterMappingIds = (mappingsRes.data ?? []).map((m) => m.id);
    if (filterMappingIds.length === 0) {
      res.json(paginated([], 0, page, limit));
      return;
    }
  }

  let query = db
    .from('price_snapshots')
    .select(
      'id, supermarket_product_id, scrape_run_id, price, list_price, unit_price, unit_price_per, in_stock, currency, tier_used, promotions, scraped_at',
      { count: 'exact' },
    )
    .order('scraped_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (filterMappingIds) query = query.in('supermarket_product_id', filterMappingIds);
  if (q.supermarket_product)
    query = query.eq('supermarket_product_id', q.supermarket_product);
  if (q.from) query = query.gte('scraped_at', `${q.from}T00:00:00Z`);
  if (q.to) query = query.lte('scraped_at', `${q.to}T23:59:59Z`);
  if (q.in_stock !== undefined) query = query.eq('in_stock', q.in_stock === 'true');

  const { data, error, count } = await query;
  if (error) throw error;

  res.json(paginated(data ?? [], count ?? 0, page, limit));
});
