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
import { parseBody, parseQuery } from '../lib/parseQuery.js';
import { getCatalogEans, invalidateCatalogCache, isBuiltInEan } from '../../shared/catalog.js';
import { getDiscoveryQueue } from '../../shared/queue.js';
import { adaptersWithSearch } from '../../discovery/index.js';
import type { TaxonomyEntry } from '../../shared/taxonomy.js';

export const catalogRouter = Router();

/** EAN-13 (allow 8–14 digits to be lenient with shorter barcodes). */
const EanSchema = z
  .string()
  .trim()
  .regex(/^\d{8,14}$/, { message: 'EAN must be 8–14 digits' });

// =============================================================================
// GET /v1/catalog/eans
//
//   ?source=extra|builtin|all   which slice of the catalog (default extra)
//   ?search=<str>               case-insensitive over ean + descriptionForms + brand
//   ?category=<str>             exact category filter
//
// source=extra preserves the original contract: raw catalog_extra_eans rows.
// source=builtin|all return the normalized union view (with a `builtin` flag,
// `created_at`, and { total, builtin, extra } counts in meta) so the frontend
// can render an EAN picker / catalog browser over all 211 built-ins + extras.
// =============================================================================

const ListEansQuery = z.object({
  source: z.enum(['extra', 'builtin', 'all']).default('extra'),
  search: z.string().trim().min(1).optional(),
  category: z.string().trim().min(1).optional(),
});

/** Case-insensitive substring match over ean + descriptionForms + brand. */
function matchesSearch(
  needle: string,
  ean: string,
  descriptionForms: string | null,
  brand: string | null,
): boolean {
  const hay = `${ean} ${descriptionForms ?? ''} ${brand ?? ''}`.toLowerCase();
  return hay.includes(needle);
}

catalogRouter.get('/eans', async (req: Request, res: Response) => {
  const q = parseQuery(req, ListEansQuery);
  const search = q.search?.toLowerCase();

  // --- source=extra: original contract (raw DB rows) ------------------------
  if (q.source === 'extra') {
    let query = db
      .from('catalog_extra_eans')
      .select('ean, description_forms, category, subcategory, brand, manufacturer, format, variety, created_by, created_at')
      .order('created_at', { ascending: false });
    if (q.category) query = query.eq('category', q.category);
    const { data, error } = await query;
    if (error) throw error;
    let rows = data ?? [];
    if (search) {
      rows = rows.filter((r) => matchesSearch(search, r.ean, r.description_forms, r.brand));
    }
    res.json(success(rows));
    return;
  }

  // --- source=builtin|all: normalized union view ----------------------------
  // Pull created_at for extras (the union map doesn't carry it).
  const extrasRes = await db.from('catalog_extra_eans').select('ean, created_at');
  if (extrasRes.error) throw extrasRes.error;
  const extraCreatedAt = new Map<string, string | null>();
  for (const r of extrasRes.data ?? []) extraCreatedAt.set(r.ean, (r.created_at as string) ?? null);

  const catalog = await getCatalogEans();

  type CatalogEntry = TaxonomyEntry & { builtin: boolean; created_at: string | null };
  let entries: CatalogEntry[] = [];
  for (const [ean, tax] of catalog) {
    const builtin = isBuiltInEan(ean);
    if (q.source === 'builtin' && !builtin) continue;
    if (q.category && tax.category !== q.category) continue;
    if (search && !matchesSearch(search, ean, tax.descriptionForms, tax.brand)) continue;
    entries.push({
      ...tax,
      builtin,
      created_at: builtin ? null : (extraCreatedAt.get(ean) ?? null),
    });
  }

  entries.sort((a, b) => a.descriptionForms.localeCompare(b.descriptionForms));

  const builtinCount = entries.reduce((n, e) => (e.builtin ? n + 1 : n), 0);
  res.json(
    success(entries, {
      total: entries.length,
      builtin: builtinCount,
      extra: entries.length - builtinCount,
    }),
  );
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
