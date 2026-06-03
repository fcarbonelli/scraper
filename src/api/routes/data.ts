/**
 * Client data endpoint.
 *
 *   GET /v1/data/pricing
 *
 * Queries the `client_base` view and returns the flat 31-column structure
 * the client's reporting tools expect. Paginated, filterable by date range,
 * supermarket, channel, and EAN.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { db } from '../../shared/db.js';
import { paginated } from '../lib/envelope.js';
import { parseQuery } from '../lib/parseQuery.js';

export const dataRouter = Router();

const PricingQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  /** Comma-separated supermarket ids (e.g. "coto,carrefour"). */
  supermarket: z.string().trim().min(1).optional(),
  canal: z.string().trim().min(1).optional(),
  ean: z.string().trim().min(1).optional(),
});

dataRouter.get('/pricing', async (req: Request, res: Response) => {
  const q = parseQuery(req, PricingQuery);
  const page = q.page;
  const limit = q.limit;
  const offset = (page - 1) * limit;

  let query = db
    .from('client_base')
    .select('*', { count: 'exact' })
    .order('Fecha_Relevamiento', { ascending: false })
    .order('ID', { ascending: false })
    .range(offset, offset + limit - 1);

  if (q.from) query = query.gte('Fecha_Relevamiento', q.from);
  if (q.to) query = query.lte('Fecha_Relevamiento', q.to);

  if (q.supermarket) {
    const ids = q.supermarket.split(',').map((s) => s.trim()).filter(Boolean);
    if (ids.length === 1) {
      query = query.eq('Cadena', ids[0].toUpperCase());
    } else if (ids.length > 1) {
      query = query.in('Cadena', ids.map((id) => id.toUpperCase()));
    }
  }

  if (q.canal) query = query.eq('Canal', q.canal);
  if (q.ean) query = query.eq('EAN', q.ean);

  const { data, error, count } = await query;
  if (error) throw error;

  res.json(paginated(data ?? [], count ?? 0, page, limit));
});
