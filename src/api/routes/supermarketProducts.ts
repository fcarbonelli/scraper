/**
 * Supermarket-product (mapping) routes.
 *
 *   PATCH  /v1/supermarket-products/:id            pause / resume scraping
 *   DELETE /v1/supermarket-products/:id            hard-remove this one mapping
 *   PATCH  /v1/supermarket-products/:id/lifecycle  durable lifecycle marker
 *
 * Pause vs lifecycle vs delete:
 *   - `is_active` (PATCH /:id) is the SCRAPE lever: false → the daily run skips
 *     this mapping entirely (gated in orchestrator/enqueue.ts) AND the mapping
 *     drops out of the client_base export (migration 008). Fully reversible —
 *     price history is retained in the DB and reappears the moment it's
 *     re-activated. This is "stop running AND hide this product here".
 *   - `lifecycle_status` (PATCH /:id/lifecycle) is a CLIENT-VISIBLE marker: the
 *     product stays is_active and IS still scraped/shown, but publish emits an
 *     out_of_stock/delisted marker so the client history stays gap-free. Use
 *     this (not pause) when a product is officially gone but you want its
 *     absence recorded for the client.
 *   - DELETE /:id hard-removes the mapping + its price history (mistakes only).
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { db } from '../../shared/db.js';
import { logger } from '../../shared/logger.js';
import { ApiError } from '../lib/apiError.js';
import { success } from '../lib/envelope.js';
import { parseBody } from '../lib/parseQuery.js';
import { LIFECYCLE_STATUSES } from '../../orchestrator/publish.js';
import { bindMappingToEan } from '../../ingest/bindEan.js';

export const supermarketProductsRouter = Router();

function requireId(req: Request): string {
  const id = req.params.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw ApiError.badRequest('Missing path parameter: id');
  }
  return id;
}

// =============================================================================
// PATCH /v1/supermarket-products/:id  — pause / resume and/or bind an EAN
//
// Body may set `is_active` (pause/resume) and/or `ean` (bind this mapping to a
// catalog EAN). At least one is required.
//
//   - `is_active=false` → the next daily run skips this mapping.
//   - `ean` → re-points the mapping to the canonical master for that EAN,
//     enriches general columns from the catalog taxonomy, and drops the
//     now-orphan blank master. Price history is preserved (snapshots key on the
//     mapping). Use this to heal EAN-less products so the export stops showing
//     blank Categoria/Marca/EAN cells. See docs/PRODUCT_MANAGEMENT.md.
// =============================================================================

const PatchBody = z
  .object({
    is_active: z.boolean().optional(),
    ean: z.string().trim().regex(/^\d{8,14}$/).optional(),
  })
  .refine((b) => b.is_active !== undefined || b.ean !== undefined, {
    message: 'provide at least one of: is_active, ean',
  });

supermarketProductsRouter.patch('/:id', async (req: Request, res: Response) => {
  const id = requireId(req);
  const body = parseBody(req, PatchBody);

  const existing = await db
    .from('supermarket_products')
    .select('id')
    .eq('id', id)
    .maybeSingle();
  if (existing.error) throw existing.error;
  if (!existing.data) throw ApiError.notFound('Supermarket product');

  // Bind the EAN first (may re-point product_id + merge masters).
  let bind: Awaited<ReturnType<typeof bindMappingToEan>> | undefined;
  if (body.ean !== undefined) {
    bind = await bindMappingToEan(id, body.ean);
  }

  if (body.is_active !== undefined) {
    const upd = await db
      .from('supermarket_products')
      .update({ is_active: body.is_active })
      .eq('id', id);
    if (upd.error) throw upd.error;
    logger.info({ smpId: id, isActive: body.is_active }, 'supermarket_product active flag changed');
  }

  const { data, error } = await db
    .from('supermarket_products')
    .select('id, supermarket_id, product_id, external_id, external_url, is_active')
    .eq('id', id)
    .single();
  if (error) throw error;

  res.json(success({ ...data, ...(bind ? { ean_binding: bind } : {}) }));
});

// =============================================================================
// DELETE /v1/supermarket-products/:id  — hard remove one mapping
//
// Removes THIS mapping only. FK cascade drops its price_snapshots and
// job_executions. The master product and other chains' mappings are untouched.
// Prefer PATCH { is_active: false } unless the row is genuinely wrong.
// =============================================================================

supermarketProductsRouter.delete('/:id', async (req: Request, res: Response) => {
  const id = requireId(req);

  const existing = await db
    .from('supermarket_products')
    .select('id, supermarket_id, external_id')
    .eq('id', id)
    .maybeSingle();
  if (existing.error) throw existing.error;
  if (!existing.data) throw ApiError.notFound('Supermarket product');

  // Count what disappears so the response is informative.
  const snapshotsRes = await db
    .from('price_snapshots')
    .select('id', { count: 'exact', head: true })
    .eq('supermarket_product_id', id);

  const { error: delErr } = await db
    .from('supermarket_products')
    .delete()
    .eq('id', id);
  if (delErr) throw delErr;

  logger.info(
    {
      smpId: id,
      supermarket: existing.data.supermarket_id,
      externalId: existing.data.external_id,
      snapshotsRemoved: snapshotsRes.count ?? 0,
    },
    'supermarket_product deleted',
  );

  res.json(
    success({
      id,
      deleted: true,
      removed: { price_snapshots: snapshotsRes.count ?? 0 },
    }),
  );
});

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
