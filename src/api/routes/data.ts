/**
 * Client data endpoints.
 *
 *   GET /v1/data/pricing   — client pricing contract { ProcesadoOk, Error, PriceData, Paginacion }
 *   GET /v1/data/export    — download the same data as .xlsx or .csv
 *   GET /v1/data/coverage  — EAN coverage per supermarket (summary + detail)
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { db, fetchAllPages } from '../../shared/db.js';
import { logger } from '../../shared/logger.js';
import { success } from '../lib/envelope.js';
import { parseQuery, parseBody } from '../lib/parseQuery.js';
import { ApiError } from '../lib/apiError.js';
import { getCatalogEans } from '../../shared/catalog.js';
import { getAdapterCapabilities } from '../../adapters/registry.js';
import {
  activeSearchableChainIds,
  adaptersWithSearch,
  type DiscoverOutcome,
} from '../../discovery/index.js';
import {
  enqueueDiscoveryJob,
  loadDiscoveryJob,
  loadDiscoveryJobs,
  loadSweepsSince,
  rollupSweepChains,
  type DiscoveryJobRecord,
} from '../../discovery/jobs.js';
import { selectDiscoveryList } from '../../discovery/listing.js';
import { buildWeeklyReport, recentIsoWeeks, type ChainSweepStat } from '../../discovery/weeklyReport.js';
import { getDiscoveryQueue, type DiscoveryJobData } from '../../shared/queue.js';
import { chainProfileFields } from '../../shared/chainProfile.js';
import { baDayRangeUtc } from '../../instore/dates.js';
import {
  fetchAllClientBase,
  loadAyudinPriceRef,
  toCsv,
  writeXlsx,
  todayInBuenosAires,
  CLIENT_DATA_FLOOR_DATE,
} from '../lib/exportClientBase.js';
import {
  toPriceData,
  buildPaginacion,
  clientPricingSuccess,
} from '../lib/clientPricing.js';
import { isCompetitorEan } from '../../shared/priceIndicators.js';
import { buildCatalogOverview, type CatalogProduct } from '../lib/catalogOverview.js';
import { buildAnalyticsOverview } from '../lib/analyticsOverview.js';

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

  // Hard client-data floor (hide everything on/before 2026-07-30).
  query = query.gte('Fecha_Relevamiento', CLIENT_DATA_FLOOR_DATE);
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

  const rows = (data ?? []) as Record<string, unknown>[];

  // IDX_VS_COMPETENCIA needs the Ayudín price of each competitor's counterpart,
  // which may live on another page. Only build the (scoped) reference when this
  // page actually has competitor rows, so non-competitor pages pay nothing.
  let idxRef: Map<string, number> | undefined;
  if (rows.some((r) => isCompetitorEan(String(r['EAN'] ?? '')))) {
    idxRef = await loadAyudinPriceRef({
      from: q.from,
      to: q.to,
      supermarket: q.supermarket,
      canal: q.canal,
    });
  }

  const priceData = rows.map((row) => toPriceData(row, idxRef));
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
  /**
   * Operator preview: include pending_review (not-yet-approved) scrape days AND
   * not-yet-approved in-store entries (migration 025) so today's data can be
   * downloaded and checked before publishing. Truthy only for `preview=true` /
   * `preview=1` (anything else is false — avoids z.coerce.boolean's "any
   * non-empty string is true" trap). Export-only — the /pricing client contract
   * ignores it.
   */
  preview: z
    .preprocess((v) => v === 'true' || v === '1' || v === true, z.boolean())
    .default(false),
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
    includeUnpublished: q.preview,
  });

  const windowLabel = from && from === to ? from : `${from ?? 'inicio'}_${to ?? 'hoy'}`;
  // Mark preview downloads so an unapproved file is never mistaken for the real one.
  const filenameBase = `client-base_${windowLabel}${q.preview ? '_preview' : ''}`;

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
// GET /v1/data/catalog
//
// Product-centric view of the EXPORTABLE set: distinct master products that
// have at least one ACTIVE mapping on an ACTIVE chain — i.e. exactly what the
// daily client_base export emits. Replaces the deprecated "catálogo" screen
// (which was backed by GET /v1/products and leaked EAN-less / never-scraped /
// fully-paused junk).
//
// Response: a paginated list of products + a `summary` KPIs block in `meta`
// (the summary always describes the whole unfiltered universe, so the headline
// count is stable regardless of the active filters/page).
//
//   ?search=coca            name / EAN / description contains (case-insensitive)
//   ?category=Gaseosas      exact category (case-insensitive)
//   ?brand=Ayudín           exact brand (case-insensitive)
//   ?supermarket=coto,vea   keep products present at any of these chains
//   ?status=active|paused|all   (default all) applied together with supermarket:
//                               restrict to products whose mapping AT those
//                               chains is active/paused. With no supermarket,
//                               'paused' = products with any paused mapping.
//   ?sort=name|coverage_desc|coverage_asc|category   (default name)
//   ?page=1 &limit=50       pagination (limit 1..500)
// =============================================================================

const CatalogQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  search: z.string().trim().min(1).max(200).optional(),
  category: z.string().trim().min(1).max(100).optional(),
  brand: z.string().trim().min(1).max(100).optional(),
  supermarket: z.string().trim().min(1).optional(),
  status: z.enum(['active', 'paused', 'all']).default('all'),
  sort: z.enum(['name', 'coverage_desc', 'coverage_asc', 'category']).default('name'),
});

dataRouter.get('/catalog', async (req: Request, res: Response) => {
  const q = parseQuery(req, CatalogQuery);
  const { summary, products } = await buildCatalogOverview();

  const requestedChains = q.supermarket
    ? new Set(q.supermarket.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))
    : null;

  // --- Filter ---------------------------------------------------------------
  let filtered = products.filter((p) => {
    if (q.search) {
      const needle = q.search.toLowerCase();
      const hay = `${p.name} ${p.ean ?? ''} ${p.descriptionForms ?? ''}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    if (q.category && (p.category ?? '').toLowerCase() !== q.category.toLowerCase()) {
      return false;
    }
    if (q.brand && (p.brand ?? '').toLowerCase() !== q.brand.toLowerCase()) {
      return false;
    }

    if (requestedChains) {
      // Keep products present at one of the requested chains, honoring status.
      const match = p.chains.some(
        (c) =>
          requestedChains.has(c.id.toLowerCase()) &&
          (q.status === 'all' || c.status === q.status),
      );
      if (!match) return false;
    } else if (q.status === 'paused') {
      // No chain filter: 'paused' surfaces products with any paused mapping.
      if (p.chainsPaused === 0) return false;
    }
    // status 'active'/'all' with no supermarket is a no-op (all are exportable).

    return true;
  });

  // --- Sort -----------------------------------------------------------------
  const byName = (a: CatalogProduct, b: CatalogProduct) => a.name.localeCompare(b.name);
  filtered = filtered.sort((a, b) => {
    switch (q.sort) {
      case 'coverage_desc':
        return b.chainsActive - a.chainsActive || byName(a, b);
      case 'coverage_asc':
        return a.chainsActive - b.chainsActive || byName(a, b);
      case 'category':
        return (a.category ?? '').localeCompare(b.category ?? '') || byName(a, b);
      case 'name':
      default:
        return byName(a, b);
    }
  });

  // --- Paginate -------------------------------------------------------------
  const total = filtered.length;
  const offset = (q.page - 1) * q.limit;
  const pageItems = filtered.slice(offset, offset + q.limit);

  res.json({
    data: pageItems,
    pagination: {
      page: q.page,
      limit: q.limit,
      total,
      totalPages: q.limit > 0 ? Math.max(1, Math.ceil(total / q.limit)) : 1,
    },
    meta: { ts: new Date().toISOString(), summary },
  });
});

// =============================================================================
// GET /v1/data/analytics/overview
//
// Pre-aggregated, catalog-wide analytics for the "Resumen" landing dashboard:
// basket price index, availability/out-of-stock patterns, biggest movers,
// per-category inflation, promotion intensity, and cross-chain competitiveness.
// Built server-side from the published snapshot set so the front never pages
// through the raw history. See docs/ANALYTICS_API_GUIDE.md (dashboard).
//
//   ?from=YYYY-MM-DD    first day (BA), inclusive (default today − 119d)
//   ?to=YYYY-MM-DD      last day (BA), inclusive (default today)
//   ?window=30          look-back for "biggest movers", in days (clamped 1..days-1)
//   ?supermarket=coto   comma-separated chains to restrict every rollup to
// =============================================================================

const AnalyticsOverviewQuery = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  window: z.coerce.number().int().min(1).max(365).default(30),
  supermarket: z.string().trim().min(1).optional(),
});

dataRouter.get('/analytics/overview', async (req: Request, res: Response) => {
  const q = parseQuery(req, AnalyticsOverviewQuery);
  const overview = await buildAnalyticsOverview({
    from: q.from,
    to: q.to,
    window: q.window,
    supermarket: q.supermarket,
  });
  res.json(success(overview));
});

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
    // Same set the worker will search: active chains that implement searchByEan.
    targets = await activeSearchableChainIds();
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

  const enqueued = await enqueueDiscoveryJob(job);
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
// GET /v1/data/discover — list recent/active discovery jobs
//
//   ?status=active|all   active = queued+running (default); all = also finished
//   ?limit=20            max jobs, newest first (cap 100)
//
// Light summary form (no results[] — fetch GET /discover/:jobId for that) so the
// UI can re-attach to a running discovery after a reload and show recent jobs.
//
// Completed sweeps from the last 8 weeks are pinned into a `status=all` page
// so a week of small EAN jobs cannot push Sunday's sweep off the 100 the
// dashboard asks for. History lives in `discovery_jobs`; Redis overlays live
// progress while the job is still there.
// =============================================================================

const DiscoverListQuery = z.object({
  status: z.enum(['active', 'all']).default('active'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

interface DiscoveryProgressView {
  total: number;
  done: number;
  found: number;
  ingested: number;
  notFound: number;
  errors: number;
}

interface DiscoveryListItem {
  jobId: string;
  scope: string;
  ean: string | null;
  supermarketId: string | null;
  status: string;
  targets: number;
  progress: DiscoveryProgressView;
  chains: ChainSweepStat[] | null;
  createdAt: string;
  finishedAt: string | null;
}

function progressOf(value: unknown): DiscoveryProgressView {
  const p = (typeof value === 'object' && value ? value : null) as Record<string, number> | null;
  return {
    total: p?.total ?? 0,
    done: p?.done ?? 0,
    found: p?.found ?? 0,
    ingested: p?.ingested ?? 0,
    notFound: p?.notFound ?? 0,
    errors: p?.errors ?? 0,
  };
}

function listItemFromRow(row: DiscoveryJobRecord): DiscoveryListItem {
  const progress = progressOf(row.progress);
  return {
    jobId: row.id,
    scope: row.scope,
    ean: row.ean,
    supermarketId: row.supermarket_id,
    status: row.status,
    targets: progress.total,
    progress,
    chains: row.scope === 'sweep' ? (row.chain_summary ?? []) : null,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

/** Normalize a BullMQ discovery job to the summary shape the UI expects. */
async function summarizeDiscoveryJob(
  job: NonNullable<Awaited<ReturnType<ReturnType<typeof getDiscoveryQueue>['getJob']>>>,
): Promise<DiscoveryListItem> {
  const data = job.data as DiscoveryJobData;
  const state = await job.getState();
  const status =
    state === 'completed' ? 'completed'
    : state === 'failed' ? 'failed'
    : state === 'active' ? 'running'
    : 'queued';

  const progress = progressOf(job.progress);
  const results = (job.returnvalue as DiscoverOutcome[] | undefined) ?? [];
  const chains =
    data.scope === 'sweep' && results.length > 0 ? rollupSweepChains(results) : null;

  return {
    jobId: job.id ?? '',
    scope: data.scope,
    ean: 'ean' in data ? data.ean : null,
    supermarketId: 'supermarketId' in data ? data.supermarketId : null,
    status,
    // `targets` = units of work (chains for ean/sweep, EANs for a whole-chain
    // scope). progress.total carries exactly that once the job starts.
    targets: progress.total,
    progress,
    chains,
    createdAt: new Date(job.timestamp).toISOString(),
    finishedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
  };
}

dataRouter.get('/discover', async (req: Request, res: Response) => {
  const q = parseQuery(req, DiscoverListQuery);
  const queue = getDiscoveryQueue();

  const types =
    q.status === 'all'
      ? (['active', 'waiting', 'delayed', 'completed', 'failed'] as const)
      : (['active', 'waiting', 'delayed'] as const);

  // DB holds jobs after Redis expires them. Redis still has the live ones,
  // including anything enqueued before the table existed.
  const [rows, redisJobs] = await Promise.all([
    loadDiscoveryJobs(500),
    queue.getJobs([...types], 0, 499),
  ]);

  const byId = new Map<string, DiscoveryListItem>();
  for (const row of rows) byId.set(row.id, listItemFromRow(row));

  const live = redisJobs.filter((j): j is NonNullable<typeof j> => Boolean(j?.id));
  const summarized = await Promise.all(live.map((job) => summarizeDiscoveryJob(job)));
  for (const item of summarized) {
    if (!item.jobId) continue;
    const prev = byId.get(item.jobId);
    byId.set(item.jobId, {
      ...(prev ?? item),
      ...item,
      chains: item.chains ?? prev?.chains ?? null,
    });
  }

  const filtered =
    q.status === 'all'
      ? [...byId.values()]
      : [...byId.values()].filter((j) => j.status === 'queued' || j.status === 'running');

  const data = selectDiscoveryList(filtered, {
    limit: q.limit,
    pinSweeps: q.status === 'all',
    nowMs: Date.now(),
  });
  res.json(success(data));
});

// =============================================================================
// GET /v1/data/discover/weekly — altas + sweep rollup per ISO week
//
// Registered before /:jobId so "weekly" is not captured as a job id.
// =============================================================================

const WeeklyQuery = z.object({
  weeks: z.coerce.number().int().min(1).max(26).default(8),
});

dataRouter.get('/discover/weekly', async (req: Request, res: Response) => {
  const q = parseQuery(req, WeeklyQuery);
  const today = todayInBuenosAires();
  const weeks = recentIsoWeeks(today, q.weeks);
  const oldest = weeks[weeks.length - 1];
  const fromUtc = oldest ? baDayRangeUtc(oldest.weekStart).fromUtc : new Date(0).toISOString();

  const { data: sms, error: smErr } = await db
    .from('supermarkets')
    .select('id, config')
    .order('name', { ascending: true });
  if (smErr) throw smErr;

  const chains = (sms ?? []).map((sm) => {
    const profile = chainProfileFields(sm.config, getAdapterCapabilities(sm.id as string));
    return { id: sm.id as string, hasSearch: profile.has_search, channels: profile.channels };
  });

  const mappingRows = await fetchAllPages<{
    supermarket_id: string;
    external_id: string;
    metadata: unknown;
    created_at: string;
  }>((from, to) =>
    db
      .from('supermarket_products')
      .select('supermarket_id, external_id, metadata, created_at')
      .gte('created_at', fromUtc)
      .order('created_at', { ascending: true })
      .range(from, to),
  );

  const sweeps = await loadSweepsSince(fromUtc);
  const report = buildWeeklyReport({
    weeks,
    chains,
    mappings: mappingRows.map((r) => ({
      supermarketId: r.supermarket_id,
      createdAt: r.created_at,
      externalId: r.external_id,
      metadata: r.metadata,
    })),
    sweeps,
  });

  res.json(success({ weeks: report }));
});

// =============================================================================
// GET /v1/data/discover/:jobId — poll discovery progress + results
//
// `?summary=1` omits the per-EAN `results` array. Sweep jobs also return
// `chains`, the per-chain rollup, so a large sweep doesn't have to be downloaded
// in full.
// =============================================================================

const DiscoverJobQuery = z.object({
  summary: z.enum(['0', '1']).optional(),
});

dataRouter.get('/discover/:jobId', async (req: Request, res: Response) => {
  const q = parseQuery(req, DiscoverJobQuery);
  const jobId = typeof req.params.jobId === 'string' ? req.params.jobId : '';
  if (!jobId) throw ApiError.badRequest('Missing path parameter: jobId');

  const job = await getDiscoveryQueue().getJob(jobId);
  const stored = job ? null : await loadDiscoveryJob(jobId);
  if (!job && !stored) throw ApiError.notFound('Discovery job');

  if (!job && stored) {
    const progress = progressOf(stored.progress);
    res.json(
      success({
        jobId: stored.id,
        scope: stored.scope,
        status: stored.status,
        progress,
        chains: stored.scope === 'sweep' ? (stored.chain_summary ?? []) : null,
        results: [],
        failedReason: stored.failed_reason,
      }),
    );
    return;
  }

  if (!job) throw ApiError.notFound('Discovery job');

  const state = await job.getState();
  const status =
    state === 'completed' ? 'completed'
    : state === 'failed' ? 'failed'
    : state === 'active' ? 'running'
    : 'queued';

  const progress = progressOf(job.progress);
  const results = (job.returnvalue as DiscoverOutcome[] | undefined) ?? [];
  const scope = (job.data as DiscoveryJobData).scope;
  const chains = scope === 'sweep' ? rollupSweepChains(results) : null;

  res.json(
    success({
      jobId: job.id,
      scope,
      status,
      progress,
      chains,
      results: q.summary === '1' ? [] : results,
      failedReason: job.failedReason ?? null,
    }),
  );
});
