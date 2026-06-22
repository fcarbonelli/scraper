/**
 * Supermarket-product (mapping) routes.
 *
 *   PATCH /v1/supermarket-products/:id/lifecycle
 *     Set a product's durable lifecycle at a chain: active | out_of_stock |
 *     delisted. Once flagged out_of_stock/delisted, publish-time reconciliation
 *     emits the matching marker instead of a generic scrape failure, so the
 *     client sees a real-world state rather than a gap.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { db } from '../../shared/db.js';
import { ApiError } from '../lib/apiError.js';
import { success } from '../lib/envelope.js';
import { parseBody } from '../lib/parseQuery.js';
import { LIFECYCLE_STATUSES } from '../../orchestrator/publish.js';

export const supermarketProductsRouter = Router();

const LifecycleBody = z.object({
  lifecycle_status: z.enum(LIFECYCLE_STATUSES),
  note: z.string().trim().max(1000).nullable().optional(),
});

supermarketProductsRouter.patch('/:id/lifecycle', async (req: Request, res: Response) => {
  const id = req.params.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw ApiError.badRequest('Missing path parameter: id');
  }
  const body = parseBody(req, LifecycleBody);

  const existing = await db
    .from('supermarket_products')
    .select('id')
    .eq('id', id)
    .maybeSingle();
  if (existing.error) throw existing.error;
  if (!existing.data) throw ApiError.notFound('Supermarket product');

  const { data, error } = await db
    .from('supermarket_products')
    .update({
      lifecycle_status: body.lifecycle_status,
      lifecycle_note: body.note ?? null,
      lifecycle_changed_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select('id, supermarket_id, external_id, external_url, lifecycle_status, lifecycle_note, lifecycle_changed_at')
    .single();
  if (error) throw error;

  res.json(success(data));
});
