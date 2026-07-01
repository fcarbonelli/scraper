/**
 * Catalog routes — runtime-editable supplement to the hardcoded EAN catalog.
 *
 *   GET    /v1/catalog/eans        list runtime-added extra EANs
 *   POST   /v1/catalog/eans        add a new official EAN (optionally auto-discover)
 *   DELETE /v1/catalog/eans/:ean   remove a runtime-added EAN
 *
 * The built-in 211 EANs (src/shared/taxonomy.ts) are immutable here. Coverage
 * and discovery read the UNION of built-in + extra (src/shared/catalog.ts).
 * See docs/PRODUCT_MANAGEMENT.md.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { db } from '../../shared/db.js';
import { logger } from '../../shared/logger.js';
import { ApiError } from '../lib/apiError.js';
import { success } from '../lib/envelope.js';
import { parseBody } from '../lib/parseQuery.js';
import { invalidateCatalogCache, isBuiltInEan } from '../../shared/catalog.js';
import { getDiscoveryQueue } from '../../shared/queue.js';
import { adaptersWithSearch } from '../../discovery/index.js';

export const catalogRouter = Router();

/** EAN-13 (allow 8–14 digits to be lenient with shorter barcodes). */
const EanSchema = z
  .string()
  .trim()
  .regex(/^\d{8,14}$/, { message: 'EAN must be 8–14 digits' });

// =============================================================================
// GET /v1/catalog/eans
// =============================================================================

catalogRouter.get('/eans', async (_req: Request, res: Response) => {
  const { data, error } = await db
    .from('catalog_extra_eans')
    .select('ean, description_forms, category, subcategory, brand, manufacturer, format, variety, created_by, created_at')
    .order('created_at', { ascending: false });
  if (error) throw error;
  res.json(success(data ?? []));
});

// =============================================================================
// POST /v1/catalog/eans
// =============================================================================

const AddEanBody = z.object({
  ean: EanSchema,
  descriptionForms: z.string().trim().min(1).max(500),
  category: z.string().trim().max(100).optional(),
  subcategory: z.string().trim().max(100).optional(),
  brand: z.string().trim().max(100).optional(),
  manufacturer: z.string().trim().max(200).optional(),
  format: z.string().trim().max(50).optional(),
  variety: z.string().trim().max(50).optional(),
  createdBy: z.string().trim().max(100).optional(),
  auto_discover: z.boolean().optional(),
});

catalogRouter.post('/eans', async (req: Request, res: Response) => {
  const body = parseBody(req, AddEanBody);

  // Built-in EANs are already official — reject to avoid confusion.
  if (isBuiltInEan(body.ean)) {
    throw ApiError.badRequest(`EAN ${body.ean} is already part of the built-in catalog`);
  }

  const { data, error } = await db
    .from('catalog_extra_eans')
    .upsert(
      {
        ean: body.ean,
        description_forms: body.descriptionForms,
        category: body.category ?? null,
        subcategory: body.subcategory ?? null,
        brand: body.brand ?? null,
        manufacturer: body.manufacturer ?? null,
        format: body.format ?? null,
        variety: body.variety ?? null,
        created_by: body.createdBy ?? null,
      },
      { onConflict: 'ean' },
    )
    .select('ean, description_forms, category, subcategory, brand, manufacturer, format, variety, created_at')
    .single();
  if (error) throw error;

  invalidateCatalogCache();
  logger.info({ ean: body.ean, autoDiscover: body.auto_discover ?? false }, 'catalog EAN added');

  // Optionally kick off discovery across all searchable chains immediately.
  let discovery: { jobId: string | undefined; status: string; targets: number } | undefined;
  if (body.auto_discover) {
    const job = await getDiscoveryQueue().add('discover', { scope: 'ean', ean: body.ean });
    discovery = { jobId: job.id, status: 'queued', targets: adaptersWithSearch().length };
  }

  res.status(201).json(success({ ...data, discovery }));
});

// =============================================================================
// DELETE /v1/catalog/eans/:ean
//
// Removes a runtime-added EAN. Built-in EANs are immutable (400). Already
// ingested mappings/snapshots are NOT touched — use the supermarket-products
// endpoints for those.
// =============================================================================

catalogRouter.delete('/eans/:ean', async (req: Request, res: Response) => {
  const raw = typeof req.params.ean === 'string' ? req.params.ean : '';
  const ean = raw.replace(/\D/g, '');
  if (!ean) throw ApiError.badRequest('Missing path parameter: ean');
  if (isBuiltInEan(ean)) {
    throw ApiError.badRequest(`EAN ${ean} is part of the built-in catalog and cannot be removed`);
  }

  const existing = await db
    .from('catalog_extra_eans')
    .select('ean')
    .eq('ean', ean)
    .maybeSingle();
  if (existing.error) throw existing.error;
  if (!existing.data) throw ApiError.notFound('Catalog EAN');

  const { error } = await db.from('catalog_extra_eans').delete().eq('ean', ean);
  if (error) throw error;

  invalidateCatalogCache();
  logger.info({ ean }, 'catalog EAN removed');
  res.json(success({ ean, deleted: true }));
});
