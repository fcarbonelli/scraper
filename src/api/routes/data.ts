/**
 * Client data endpoints.
 *
 *   GET /v1/data/pricing   — client pricing contract { ProcesadoOk, Error, PriceData, Paginacion }
 *   GET /v1/data/export    — download the same data as .xlsx or .csv
 *   GET /v1/data/coverage  — EAN coverage per supermarket (summary + detail)
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { db } from '../../shared/db.js';
import { logger } from '../../shared/logger.js';
import { success } from '../lib/envelope.js';
import { parseQuery, parseBody } from '../lib/parseQuery.js';
import { ApiError } from '../lib/apiError.js';
import { getCatalogEans } from '../../shared/catalog.js';
import { getAdapterCapabilities } from '../../adapters/registry.js';
import { adaptersWithSearch, type DiscoverOutcome } from '../../discovery/index.js';
import { getDiscoveryQueue, type DiscoveryJobData } from '../../shared/queue.js';
import {
  fetchAllClientBase,
  toCsv,
  writeXlsx,
  todayInBuenosAires,
} from '../lib/exportClientBase.js';
import {
  toPriceData,
  buildPaginacion,
  clientPricingSuccess,
} from '../lib/clientPricing.js';

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
  // Validate explicitly so we can return a Spanish message in the client
  // envelope (the global error handler renders it for this path).
  const parsed = PricingQuery.safeParse(req.query);
  if (!parsed.success) {
    const detalle = parsed.error.issues
      .map((i) => `${i.path.join('.') || 'query'}: ${i.message}`)
      .join('; ');
    throw ApiError.badRequest(`Parámetros de consulta inválidos: ${detalle}`);
  }
  const q = parsed.data;
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
    const first = ids[0];
    if (ids.length === 1 && first) {
      query = query.eq('Cadena', first.toUpperCase());
    } else if (ids.length > 1) {
      query = query.in('Cadena', ids.map((id) => id.toUpperCase()));
    }
  }

  if (q.canal) query = query.eq('Canal', q.canal);
  if (q.ean) query = query.eq('EAN', q.ean);

  const { data, error, count } = await query;
  // On a DB error we throw: the global error handler renders the client-format
  // error envelope ({ ProcesadoOk: false, ... }) for this path.
  if (error) throw error;

  const priceData = (data ?? []).map((row) =>
    toPriceData(row as Record<string, unknown>),
  );
  res.json(clientPricingSuccess(priceData, buildPaginacion(page, limit, count ?? 0)));
});

// =============================================================================
// GET /v1/data/export
//
// Downloads client_base rows as a real .xlsx workbook (default) or .csv.
// Intended for the "daily data" use case: with no params it returns just
// today's data (Argentina time). Supports the same filters as /pricing.
//
//   ?format=xlsx|csv        file type (default xlsx)
//   ?date=2026-06-11        single day (shorthand for from=to=date)
//   ?from=...&to=...        explicit date range (on Fecha_Relevamiento)
//   ?supermarket=coto,...   comma-separated chains
//   ?canal=...  ?ean=...    channel / single EAN
// =============================================================================

const ExportQuery = z.object({
  format: z.enum(['xlsx', 'csv']).default('xlsx'),
  date: z.iso.date().optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  supermarket: z.string().trim().min(1).optional(),
  canal: z.string().trim().min(1).optional(),
  ean: z.string().trim().min(1).optional(),
});

dataRouter.get('/export', async (req: Request, res: Response) => {
  const q = parseQuery(req, ExportQuery);

  // Resolve the date window: an explicit `date` wins; otherwise use from/to;
  // if nothing is given, default to today so "download daily data" just works.
  let from = q.from;
  let to = q.to;
  if (q.date) {
    from = q.date;
    to = q.date;
  }
  if (!from && !to) {
    const today = todayInBuenosAires();
    from = today;
    to = today;
  }

  // Fetch everything up front so any DB error surfaces as JSON before we
  // start writing the download stream.
  const rows = await fetchAllClientBase({
    from,
    to,
    supermarket: q.supermarket,
    canal: q.canal,
    ean: q.ean,
  });

  const windowLabel = from && from === to ? from : `${from ?? 'inicio'}_${to ?? 'hoy'}`;
  const filenameBase = `client-base_${windowLabel}`;

  if (q.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.csv"`);
    res.send(toCsv(rows));
    return;
  }

  // xlsx: writeXlsx sets its own headers (after confirming exceljs is available).
  await writeXlsx(res, rows, filenameBase);
});

// =============================================================================
// GET /v1/data/coverage
//
// EAN coverage per supermarket: which of the 211 client EANs are mapped
// (have a supermarket_products row) vs missing at each chain.
//
// Summary mode (no ?supermarket or multiple): per-chain counts
// Detail mode  (?supermarket=carrefour): full EAN-level list with status
// =============================================================================

const CoverageQuery = z.object({
  supermarket: z.string().trim().min(1).optional(),
  status: z.enum(['covered', 'missing']).optional(),
  category: z.string().trim().min(1).optional(),
});

dataRouter.get('/coverage', async (req: Request, res: Response) => {
  const q = parseQuery(req, CoverageQuery);
  const catalog = await getCatalogEans();
  const taxonomyEans = Array.from(catalog.keys());
  const totalEans = taxonomyEans.length;

  // Fetch ALL supermarket_products (active AND paused) with their product EAN.
  // A paused mapping (is_active=false) still means "we have a URL for this" —
  // it must count as covered (just paused), not silently fall back to missing.
  const { data: mappings, error: mappingsErr } = await db
    .from('supermarket_products')
    .select('supermarket_id, external_url, is_active, products:product_id ( ean )');
  if (mappingsErr) throw mappingsErr;

  // Build per-chain sets. `coveredByChain` = any mapping (active or paused);
  // `activeByChain` = at least one active mapping. paused = covered && !active.
  const coveredByChain = new Map<string, Set<string>>();
  const activeByChain = new Map<string, Set<string>>();
  const urlByChainEan = new Map<string, Map<string, string | null>>();

  for (const row of mappings ?? []) {
    const product = Array.isArray(row.products) ? row.products[0] : row.products;
    const ean = product?.ean;
    if (!ean) continue;

    if (!coveredByChain.has(row.supermarket_id)) {
      coveredByChain.set(row.supermarket_id, new Set());
      activeByChain.set(row.supermarket_id, new Set());
      urlByChainEan.set(row.supermarket_id, new Map());
    }
    coveredByChain.get(row.supermarket_id)!.add(ean);
    if (row.is_active) activeByChain.get(row.supermarket_id)!.add(ean);
    // Prefer an active mapping's URL; keep the first URL otherwise.
    const urlMap = urlByChainEan.get(row.supermarket_id)!;
    if (row.is_active || !urlMap.has(ean)) urlMap.set(ean, row.external_url ?? null);
  }

  // Parse requested supermarket(s)
  const requestedIds = q.supermarket
    ? q.supermarket.split(',').map((s) => s.trim()).filter(Boolean)
    : null;
  const isSingleDetail = requestedIds?.length === 1;

  // --- Detail mode: single supermarket with per-EAN breakdown ---------------
  if (isSingleDetail) {
    const smId = requestedIds[0]!;

    const { data: sm, error: smErr } = await db
      .from('supermarkets')
      .select('id, name, canal, cadena_display_name, is_active')
      .eq('id', smId)
      .maybeSingle();
    if (smErr) throw smErr;

    const caps = getAdapterCapabilities(smId);
    const coveredSet = coveredByChain.get(smId) ?? new Set<string>();
    const activeSet = activeByChain.get(smId) ?? new Set<string>();
    const urlMap = urlByChainEan.get(smId) ?? new Map<string, string | null>();

    const products: CoverageProduct[] = [];
    let pausedCount = 0;
    for (const ean of taxonomyEans) {
      const tax = catalog.get(ean)!;
      const isCovered = coveredSet.has(ean);
      const isActive = activeSet.has(ean);
      const status = isCovered ? 'covered' as const : 'missing' as const;
      if (isCovered && !isActive) pausedCount++;

      if (q.status && q.status !== status) continue;
      if (q.category && tax.category !== q.category) continue;

      products.push({
        ean,
        descriptionForms: tax.descriptionForms,
        category: tax.category,
        subcategory: tax.subcategory,
        brand: tax.brand,
        status,
        active: isCovered ? isActive : null,
        url: isCovered ? (urlMap.get(ean) ?? null) : null,
      });
    }

    const coveredCount = coveredSet.size;
    const missingCount = totalEans - coveredCount;

    res.json(success({
      supermarket: {
        id: sm?.id ?? smId,
        name: sm?.name ?? smId,
        canal: sm?.canal ?? null,
        cadenaDisplayName: sm?.cadena_display_name ?? null,
        isActive: sm?.is_active ?? false,
        ...caps,
      },
      totalEans,
      covered: coveredCount,
      missing: missingCount,
      paused: pausedCount,
      coveragePct: Math.round((coveredCount / totalEans) * 1000) / 10,
      products,
    }));
    return;
  }

  // --- Summary mode: all (or filtered) supermarkets -------------------------
  const { data: allSupermarkets, error: smErr } = await db
    .from('supermarkets')
    .select('id, name, canal, cadena_display_name, is_active')
    .order('name', { ascending: true });
  if (smErr) throw smErr;

  const supermarkets = (allSupermarkets ?? [])
    .filter((sm) => !requestedIds || requestedIds.includes(sm.id))
    .map((sm) => {
      const coveredSet = coveredByChain.get(sm.id) ?? new Set<string>();
      const activeSet = activeByChain.get(sm.id) ?? new Set<string>();
      // Only count EANs that are in the catalog (ignore non-catalog products)
      let coveredCount = 0;
      let pausedCount = 0;
      for (const ean of taxonomyEans) {
        if (!coveredSet.has(ean)) continue;
        coveredCount++;
        if (!activeSet.has(ean)) pausedCount++;
      }
      const caps = getAdapterCapabilities(sm.id);

      return {
        id: sm.id,
        name: sm.name,
        canal: sm.canal,
        cadenaDisplayName: sm.cadena_display_name,
        isActive: sm.is_active,
        ...caps,
        covered: coveredCount,
        missing: totalEans - coveredCount,
        paused: pausedCount,
        coveragePct: Math.round((coveredCount / totalEans) * 1000) / 10,
      };
    });

  res.json(success({ totalEans, supermarkets }));
});

interface CoverageProduct {
  ean: string;
  descriptionForms: string;
  category: string;
  subcategory: string;
  brand: string;
  status: 'covered' | 'missing';
  /** true=active, false=paused, null=missing (no mapping). */
  active: boolean | null;
  url: string | null;
}

// =============================================================================
// POST /v1/data/discover
//
// Enqueue an async discovery job. Discovery searches live supermarket sites
// (slow, rate-limited) so it can't run inside the request. Returns a jobId to
// poll via GET /v1/data/discover/:jobId. Three scopes:
//   { ean }                    → search this EAN at every chain with search
//   { supermarket }            → search all catalog EANs at one chain
//   { ean, supermarket }       → one EAN at one chain
// =============================================================================

const DiscoverBody = z
  .object({
    ean: z.string().trim().regex(/^\d{8,14}$/).optional(),
    supermarket: z.string().trim().min(1).max(100).optional(),
    /** Coverage sweep: re-search MISSING EANs at every searchable chain. */
    sweep: z.boolean().optional(),
  })
  .refine((b) => b.ean || b.supermarket || b.sweep, {
    message: 'provide at least one of: ean, supermarket, sweep',
  });

dataRouter.post('/discover', async (req: Request, res: Response) => {
  const body = parseBody(req, DiscoverBody);

  let job: DiscoveryJobData;
  let targets: string[];
  if (body.sweep) {
    job = { scope: 'sweep' };
    // Actual active-chain filtering happens at run time; report the searchable universe.
    targets = adaptersWithSearch();
  } else if (body.ean && body.supermarket) {
    job = { scope: 'ean_at_supermarket', ean: body.ean, supermarketId: body.supermarket };
    targets = [body.supermarket];
  } else if (body.ean) {
    job = { scope: 'ean', ean: body.ean };
    targets = adaptersWithSearch();
  } else {
    // supermarket-only
    job = { scope: 'supermarket', supermarketId: body.supermarket! };
    targets = [body.supermarket!];
  }

  const enqueued = await getDiscoveryQueue().add('discover', job);
  logger.info({ jobId: enqueued.id, scope: job.scope }, 'discovery job enqueued');

  res.status(201).json(
    success({
      jobId: enqueued.id,
      scope: job.scope,
      targets,
      status: 'queued',
    }),
  );
});

// =============================================================================
// GET /v1/data/discover/:jobId — poll discovery progress + results
// =============================================================================

dataRouter.get('/discover/:jobId', async (req: Request, res: Response) => {
  const jobId = typeof req.params.jobId === 'string' ? req.params.jobId : '';
  if (!jobId) throw ApiError.badRequest('Missing path parameter: jobId');

  const job = await getDiscoveryQueue().getJob(jobId);
  if (!job) throw ApiError.notFound('Discovery job');

  // Map BullMQ states to a simple lifecycle for the UI.
  const state = await job.getState();
  const status =
    state === 'completed' ? 'completed'
    : state === 'failed' ? 'failed'
    : state === 'active' ? 'running'
    : 'queued';

  const progress = (typeof job.progress === 'object' ? job.progress : null) as
    | Record<string, number>
    | null;
  const results = (job.returnvalue as DiscoverOutcome[] | undefined) ?? [];

  res.json(
    success({
      jobId: job.id,
      scope: (job.data as DiscoveryJobData).scope,
      status,
      progress,
      results,
      failedReason: job.failedReason ?? null,
    }),
  );
});
