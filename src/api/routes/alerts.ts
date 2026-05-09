/**
 * Alert routes.
 *
 *   GET   /v1/alerts             list with severity/status/supermarket filters
 *   PATCH /v1/alerts/:id         transition status (acknowledge/resolve)
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { db } from '../../shared/db.js';
import { ApiError } from '../lib/apiError.js';
import { paginated, success } from '../lib/envelope.js';
import { parseBody, parseQuery, PaginationQuery } from '../lib/parseQuery.js';

export const alertsRouter = Router();

// =============================================================================
// GET /v1/alerts
// =============================================================================

const ListQuery = PaginationQuery.extend({
  status: z.enum(['open', 'acknowledged', 'resolved']).optional(),
  severity: z.enum(['info', 'warning', 'critical']).optional(),
  supermarket: z.string().trim().min(1).optional(),
});

alertsRouter.get('/', async (req: Request, res: Response) => {
  const q = parseQuery(req, ListQuery);
  const page = req.pagination?.page ?? q.page;
  const limit = req.pagination?.limit ?? q.limit;
  const offset = req.pagination?.offset ?? (page - 1) * limit;

  let query = db
    .from('alerts')
    .select(
      'id, severity, type, supermarket_id, product_id, title, message, context, status, created_at, resolved_at',
      { count: 'exact' },
    )
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (q.status) query = query.eq('status', q.status);
  if (q.severity) query = query.eq('severity', q.severity);
  if (q.supermarket) query = query.eq('supermarket_id', q.supermarket);

  const { data, error, count } = await query;
  if (error) throw error;

  res.json(paginated(data ?? [], count ?? 0, page, limit));
});

// =============================================================================
// PATCH /v1/alerts/:id
//
// Body: { status: "acknowledged" | "resolved" }
// Idempotent: setting the same status returns the same row, no error.
// =============================================================================

const UpdateBody = z.object({
  status: z.enum(['acknowledged', 'resolved']),
});

alertsRouter.patch('/:id', async (req: Request, res: Response) => {
  const body = parseBody(req, UpdateBody);

  // Confirm exists first so we return 404, not silent no-op
  const existing = await db
    .from('alerts')
    .select('id, status')
    .eq('id', req.params.id)
    .maybeSingle();
  if (existing.error) throw existing.error;
  if (!existing.data) throw ApiError.notFound('Alert');

  const update: { status: string; resolved_at?: string } = { status: body.status };
  if (body.status === 'resolved') update.resolved_at = new Date().toISOString();

  const { data, error } = await db
    .from('alerts')
    .update(update)
    .eq('id', req.params.id)
    .select(
      'id, severity, type, supermarket_id, product_id, title, message, context, status, created_at, resolved_at',
    )
    .single();
  if (error) throw error;

  res.json(success(data));
});
