/**
 * Analytics overview aggregation for the "Resumen" landing dashboard.
 *
 * Powers `GET /v1/data/analytics/overview`. It reads the daily-published price
 * snapshot set (same visibility rule as `/v1/data/pricing`: published runs +
 * run-less ad-hoc/manual snapshots, active chains & mappings, EAN required) and
 * rolls it up into a bundle of pre-aggregated time series so the front never has
 * to page through the raw history:
 *
 *   - basket           Laspeyres price index (base 100 at range start, LOCF)
 *   - availability     in-stock rate over time + chain/category/weekday rollups
 *   - movers           biggest per-cell increases/decreases + most volatile
 *   - categories       per-category inflation with a base-100 sparkline
 *   - promotions       promo share + discount depth over time and per chain
 *   - competitiveness  per-chain basket index + cross-chain price dispersion
 *
 * The math mirrors the deterministic front-end mock (dashboard
 * `src/lib/mock-analytics.ts`) one-to-one for shape, units, base-100 conventions
 * and sort orders — the difference is this reads real snapshots instead of a
 * seeded RNG. See docs/ANALYTICS_API_GUIDE.md (dashboard) for the contract.
 *
 * All calendar bucketing is done in America/Argentina/Buenos_Aires, matching
 * `Fecha_Relevamiento` semantics everywhere else.
 */

import { db, PG_PAGE_SIZE } from '../../shared/db.js';
import { CLIENT_DATA_FLOOR_DATE, todayInBuenosAires } from './exportClientBase.js';

// ---------------------------------------------------------------------------
// Response shape (subset of the dashboard's AnalyticsOverview in src/types/api.ts)
// ---------------------------------------------------------------------------

export interface AnalyticsRange {
  from: string;
  to: string;
  days: number;
}

export interface IndexPoint {
  date: string;
  index: number;
}

export interface BasketAnalytics {
  constituents: number;
  cadence: 'daily' | 'weekly';
  points: IndexPoint[];
  nominalChangePct: number;
  monthlyChangePct: number;
  annualizedPct: number;
  currentBasketArs: number;
}

export interface AvailabilityPoint {
  date: string;
  availabilityPct: number;
  oosCount: number;
  tracked: number;
}

export interface AvailabilityGroup {
  key: string;
  label: string;
  availabilityPct: number;
  oosCount: number;
}

export interface ChronicOosProduct {
  productId: string;
  name: string;
  ean: string | null;
  category: string | null;
  supermarketId: string | null;
  supermarketName: string | null;
  oosDays: number;
  oosRatePct: number;
}

export interface AvailabilityAnalytics {
  points: AvailabilityPoint[];
  currentPct: number;
  avgPct: number;
  byChain: AvailabilityGroup[];
  byCategory: AvailabilityGroup[];
  chronic: ChronicOosProduct[];
  weekday: Array<{ weekday: number; availabilityPct: number }>;
  oosPrecedesHikePct: number | null;
}

export interface PriceMover {
  productId: string;
  name: string;
  ean: string | null;
  category: string | null;
  supermarketId: string | null;
  supermarketName: string | null;
  fromPrice: number;
  toPrice: number;
  changePct: number;
}

export interface VolatileProduct {
  productId: string;
  name: string;
  ean: string | null;
  category: string | null;
  cvPct: number;
  minPrice: number;
  maxPrice: number;
}

export interface MoversAnalytics {
  windowDays: number;
  topIncreases: PriceMover[];
  topDecreases: PriceMover[];
  mostVolatile: VolatileProduct[];
}

export interface CategoryInflation {
  category: string;
  products: number;
  changePct: number;
  monthlyPct: number;
  spark: number[];
}

export interface PromoPoint {
  date: string;
  promoSharePct: number;
  avgDiscountPct: number;
}

export interface PromoGroup {
  supermarketId: string;
  name: string;
  promoSharePct: number;
  avgDiscountPct: number;
}

export interface PromotionAnalytics {
  points: PromoPoint[];
  currentSharePct: number;
  avgDiscountPct: number;
  byChain: PromoGroup[];
}

export interface ChainBasketPoint {
  date: string;
  byChain: Record<string, number>;
}

export interface ChainRanking {
  supermarketId: string;
  name: string;
  avgBasket: number;
  cheapestDays: number;
  rank: number;
}

export interface CompetitivenessAnalytics {
  chains: Array<{ supermarketId: string; name: string }>;
  points: ChainBasketPoint[];
  dispersionPoints: Array<{ date: string; dispersionPct: number }>;
  ranking: ChainRanking[];
}

export interface AnalyticsOverview {
  range: AnalyticsRange;
  generatedAt: string;
  basket: BasketAnalytics;
  availability: AvailabilityAnalytics;
  movers: MoversAnalytics;
  categories: CategoryInflation[];
  promotions: PromotionAnalytics;
  competitiveness: CompetitivenessAnalytics;
}

export interface AnalyticsOverviewParams {
  from?: string | undefined;
  to?: string | undefined;
  /** Look-back for the "biggest movers" comparison, in days. */
  window?: number | undefined;
  /** Comma-separated supermarket ids; restricts every rollup to these chains. */
  supermarket?: string | undefined;
}

// ---------------------------------------------------------------------------
// Small numeric helpers (mirror the dashboard mock exactly)
// ---------------------------------------------------------------------------

/** Round to `dp` decimal places (banker-agnostic, matches the mock's Math.round). */
function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

const mean = (xs: number[]): number =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

/** Coerce a PostgREST numeric (number|string|null) to a finite number or null. */
function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Buenos Aires calendar helpers
// ---------------------------------------------------------------------------

const BA_TZ = 'America/Argentina/Buenos_Aires';
const baDateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: BA_TZ });

/** `YYYY-MM-DD` calendar day (BA) for an absolute instant. */
function baDate(d: Date): string {
  return baDateFmt.format(d);
}

/** Add `n` days to a `YYYY-MM-DD` string (pure calendar math, UTC-anchored). */
function addDays(dateStr: string, n: number): string {
  const t = Date.parse(`${dateStr}T00:00:00Z`);
  return new Date(t + n * 86_400_000).toISOString().slice(0, 10);
}

/** Weekday index with Monday = 0 … Sunday = 6, for a `YYYY-MM-DD` string. */
function mondayIndex(dateStr: string): number {
  const dow = new Date(`${dateStr}T00:00:00Z`).getUTCDay(); // 0=Sun..6=Sat
  return (dow + 6) % 7;
}

/** Inclusive list of `YYYY-MM-DD` days from `from` to `to`. */
function dayRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

// ---------------------------------------------------------------------------
// Raw snapshot fetch (published set, same gates as client_base)
// ---------------------------------------------------------------------------

/** Normalized snapshot row after unwrapping the embedded joins. */
interface SnapRow {
  scrapedAt: string;
  price: number | null;
  listPrice: number | null;
  inStock: boolean;
  status: string;
  offer1: number | null;
  offer2: number | null;
  unitDiscount: number | null;
  promotion1: string | null;
  promotion2: string | null;
  reviewStatus: string | null;
  cellId: string;
  supermarketId: string;
  supermarketName: string;
  productId: string;
  productName: string;
  ean: string | null;
  category: string | null;
}

/** Unwrap a PostgREST embedded relation that may come back as an object or [obj]. */
function one<T>(v: unknown): T | null {
  if (Array.isArray(v)) return (v[0] ?? null) as T | null;
  return (v ?? null) as T | null;
}

/** Columns + embedded joins we need from each published snapshot. */
const SNAPSHOT_SELECT = `scraped_at, price, list_price, in_stock, status,
  offer_price_1, offer_price_2, unit_discount, promotion_1, promotion_2,
  scrape_run_id,
  scrape_runs ( review_status ),
  supermarket_products!inner (
    id, supermarket_id, is_active,
    products!inner ( id, category, name, ean ),
    supermarkets!inner ( id, name, cadena_display_name, is_active )
  )`;

/** How many page fetches to run at once (bounds concurrent DB round-trips). */
const FETCH_CONCURRENCY = 6;

/** Run `fn` over `items` with at most `limit` in flight; preserves input order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

async function fetchPublishedSnapshots(
  fromDate: string,
  toDate: string,
  supermarketIds: string[] | null,
): Promise<SnapRow[]> {
  // BA-day bounds converted to absolute instants (BA is UTC-3, no DST).
  const lowerUtc = new Date(`${fromDate}T00:00:00-03:00`).toISOString();
  const upperUtc = new Date(`${toDate}T23:59:59.999-03:00`).toISOString();

  // Base query builder shared by the count probe and every page fetch, so the
  // filters can never drift between them.
  const build = (opts?: { count: 'exact'; head: true }) => {
    let q = db
      .from('price_snapshots')
      .select(SNAPSHOT_SELECT, opts)
      // Published set: never expose the internal-only 'scrape_failed' marker.
      .in('status', ['ok', 'out_of_stock', 'not_found', 'delisted'])
      .gte('scraped_at', lowerUtc)
      .lte('scraped_at', upperUtc)
      // Active gate (mirrors client_base migration 008): a paused mapping
      // disappears entirely. The chain-level `supermarkets.is_active` gate is
      // enforced in Node below (a two-level embedded filter is less portable
      // across PostgREST versions than this single-level one).
      .eq('supermarket_products.is_active', true);
    if (supermarketIds && supermarketIds.length > 0) {
      q = q.in('supermarket_products.supermarket_id', supermarketIds);
    }
    return q;
  };

  // Probe the total row count so we can fetch all pages in parallel (much faster
  // than sequential paging for a wide window: tens of thousands of rows).
  const { count, error: countErr } = await build({ count: 'exact', head: true });
  if (countErr) throw countErr;
  const total = count ?? 0;

  const pageCount = Math.max(1, Math.ceil(total / PG_PAGE_SIZE));
  const pageIndexes = Array.from({ length: pageCount }, (_, i) => i);

  const pages = await mapWithConcurrency(pageIndexes, FETCH_CONCURRENCY, async (i) => {
    const from = i * PG_PAGE_SIZE;
    const { data, error } = await build()
      // Stable order so disjoint page ranges cover the set exactly once.
      .order('id', { ascending: true })
      .range(from, from + PG_PAGE_SIZE - 1);
    if (error) throw error;
    return (data ?? []) as Record<string, unknown>[];
  });
  const raw = pages.flat();

  const rows: SnapRow[] = [];
  for (const r of raw) {
    const sp = one<Record<string, unknown>>(r['supermarket_products']);
    if (!sp || sp['is_active'] === false) continue;
    const sm = one<Record<string, unknown>>(sp['supermarkets']);
    if (!sm || sm['is_active'] === false) continue;
    const prod = one<Record<string, unknown>>(sp['products']);
    if (!prod) continue;

    // EAN required (mirrors client_base migration 021).
    const ean = prod['ean'] == null ? '' : String(prod['ean']).trim();
    if (!ean) continue;

    // Publication gate: run-less snapshots are trusted; otherwise the run must
    // be published. Expressing "run IS NULL OR published" is awkward in
    // PostgREST, so we fetch review_status and filter here.
    const run = one<Record<string, unknown>>(r['scrape_runs']);
    const reviewStatus = run ? (run['review_status'] as string | null) : null;
    if (run && reviewStatus !== 'published') continue;

    const category = prod['category'] == null ? null : String(prod['category']);

    rows.push({
      scrapedAt: String(r['scraped_at']),
      price: num(r['price']),
      listPrice: num(r['list_price']),
      inStock: r['in_stock'] === true,
      status: String(r['status']),
      offer1: num(r['offer_price_1']),
      offer2: num(r['offer_price_2']),
      unitDiscount: num(r['unit_discount']),
      promotion1: r['promotion_1'] == null ? null : String(r['promotion_1']),
      promotion2: r['promotion_2'] == null ? null : String(r['promotion_2']),
      reviewStatus,
      cellId: String(sp['id']),
      supermarketId: String(sm['id']),
      supermarketName:
        (sm['cadena_display_name'] as string | null) ?? String(sm['name']),
      productId: String(prod['id']),
      productName: String(prod['name']),
      ean,
      category,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Panel: one cell (= supermarket_product mapping) × day
// ---------------------------------------------------------------------------

interface Cell {
  cellId: string;
  supermarketId: string;
  supermarketName: string;
  productId: string;
  productName: string;
  ean: string | null;
  category: string | null;
  /** Observed shelf price per day (promo price if on offer); null when not `ok`. */
  observed: (number | null)[];
  /** LOCF-carried price; null on days before the cell's first observation. */
  carry: (number | null)[];
  /** Availability in-stock flag = status 'ok' AND in_stock. */
  inStock: boolean[];
  /** Whether an active offer applied that day (only meaningful when in stock). */
  onPromo: boolean[];
  /** Discount depth that day, percent (0 when no promo). */
  discount: number[];
  /** Whether any published snapshot existed that day. */
  hasRow: boolean[];
  /** Day index of the first observed price, or -1. */
  firstObs: number;
  /** Day index of the first / last day with any row, or -1. */
  firstRow: number;
  lastRow: number;
}

/** Shelf price = LEAST(price, coalesce(offer1,price), coalesce(offer2,price)). */
function shelfPrice(r: SnapRow): number | null {
  if (r.price == null) return null;
  let s = r.price;
  if (r.offer1 != null && r.offer1 < s) s = r.offer1;
  if (r.offer2 != null && r.offer2 < s) s = r.offer2;
  return s;
}

function nonEmpty(s: string | null): boolean {
  return s != null && s.trim().length > 0;
}

/** Build the cell×day panel over the given days from the fetched snapshots. */
function buildPanel(rows: SnapRow[], days: string[]): Cell[] {
  const D = days.length;
  const idxOf = new Map<string, number>();
  days.forEach((d, i) => idxOf.set(d, i));

  const cells = new Map<string, Cell>();

  for (const r of rows) {
    const i = idxOf.get(baDate(new Date(r.scrapedAt)));
    if (i === undefined) continue; // outside the effective range

    let cell = cells.get(r.cellId);
    if (!cell) {
      cell = {
        cellId: r.cellId,
        supermarketId: r.supermarketId,
        supermarketName: r.supermarketName,
        productId: r.productId,
        productName: r.productName,
        ean: r.ean,
        category: r.category,
        observed: new Array<number | null>(D).fill(null),
        carry: new Array<number | null>(D).fill(null),
        inStock: new Array<boolean>(D).fill(false),
        onPromo: new Array<boolean>(D).fill(false),
        discount: new Array<number>(D).fill(0),
        hasRow: new Array<boolean>(D).fill(false),
        firstObs: -1,
        firstRow: -1,
        lastRow: -1,
      };
      cells.set(r.cellId, cell);
    }

    const isOk = r.status === 'ok';
    const shelf = isOk ? shelfPrice(r) : null;
    const inStock = isOk && r.inStock;

    const markdown = r.listPrice != null && r.price != null && r.listPrice > r.price;
    const named = nonEmpty(r.promotion1) || nonEmpty(r.promotion2);
    const promoted = isOk && (markdown || named);

    let depthPct = 0;
    if (promoted) {
      const markdownFrac =
        markdown && r.listPrice ? (r.listPrice - (r.price as number)) / r.listPrice : 0;
      const udFrac = r.unitDiscount ?? 0;
      depthPct = Math.max(markdownFrac, udFrac) * 100;
    }

    // Merge duplicates for the same cell/day: prefer the cheapest observed price
    // and OR the availability/promo flags (rare, but keeps the panel stable).
    cell.hasRow[i] = true;
    if (shelf != null) {
      const prev = cell.observed[i];
      cell.observed[i] = prev == null ? shelf : Math.min(prev, shelf);
    }
    if (inStock) cell.inStock[i] = true;
    if (promoted) {
      cell.onPromo[i] = true;
      cell.discount[i] = Math.max(cell.discount[i]!, depthPct);
    }
  }

  // Finalize per-cell derived fields: first/last row, first observation, LOCF.
  const out: Cell[] = [];
  for (const cell of cells.values()) {
    let last: number | null = null;
    for (let i = 0; i < D; i++) {
      if (cell.hasRow[i]) {
        if (cell.firstRow === -1) cell.firstRow = i;
        cell.lastRow = i;
      }
      const obs = cell.observed[i]!;
      if (obs != null) {
        if (cell.firstObs === -1) cell.firstObs = i;
        last = obs;
      }
      cell.carry[i] = last;
    }
    out.push(cell);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Empty overview (graceful degradation when there's no data)
// ---------------------------------------------------------------------------

function emptyOverview(from: string, to: string, windowDays: number): AnalyticsOverview {
  const days = from && to && from <= to ? dayRange(from, to).length : 0;
  return {
    range: { from, to, days },
    generatedAt: new Date().toISOString(),
    basket: {
      constituents: 0,
      cadence: 'daily',
      points: [],
      nominalChangePct: 0,
      monthlyChangePct: 0,
      annualizedPct: 0,
      currentBasketArs: 0,
    },
    availability: {
      points: [],
      currentPct: 0,
      avgPct: 0,
      byChain: [],
      byCategory: [],
      chronic: [],
      weekday: Array.from({ length: 7 }, (_, wd) => ({ weekday: wd, availabilityPct: 0 })),
      oosPrecedesHikePct: null,
    },
    movers: { windowDays, topIncreases: [], topDecreases: [], mostVolatile: [] },
    categories: [],
    promotions: { points: [], currentSharePct: 0, avgDiscountPct: 0, byChain: [] },
    competitiveness: { chains: [], points: [], dispersionPoints: [], ranking: [] },
  };
}

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

function buildBasket(cells: Cell[], days: string[]): BasketAnalytics {
  const D = days.length;
  // Laspeyres fixed basket: constituents are cells with an observed price on the
  // first day (so carry is defined for the whole window). Cells that enter later
  // (no day-0 price) are excluded — that's what makes it an inflation index.
  const constituents = cells.filter((c) => c.observed[0] != null);

  const B: number[] = new Array<number>(D).fill(0);
  for (let d = 0; d < D; d++) {
    let sum = 0;
    for (const c of constituents) sum += c.carry[d] ?? 0;
    B[d] = sum;
  }

  const base = B[0]!;
  const points: IndexPoint[] = days.map((date, d) => ({
    date,
    index: base > 0 ? round((B[d]! / base) * 100, 2) : 0,
  }));

  const last = B[D - 1]!;
  const nominalChangePct = base > 0 ? round((last / base - 1) * 100, 1) : 0;
  const prior30 = D > 30 ? B[D - 31]! : 0;
  const monthlyChangePct =
    D > 30 && prior30 > 0 ? round((last / prior30 - 1) * 100, 1) : nominalChangePct;
  const annualizedPct =
    base > 0 ? round(((last / base) ** (365 / D) - 1) * 100, 1) : 0;

  return {
    constituents: constituents.length,
    cadence: 'daily',
    points,
    nominalChangePct,
    monthlyChangePct,
    annualizedPct,
    currentBasketArs: round(last, 0),
  };
}

function buildAvailability(cells: Cell[], days: string[]): AvailabilityAnalytics {
  const D = days.length;

  // A cell is "tracked" on day d within its observed lifespan [firstRow, lastRow];
  // gaps and markers inside that span count as out of stock.
  const isTracked = (c: Cell, d: number): boolean =>
    c.firstRow !== -1 && d >= c.firstRow && d <= c.lastRow;

  const points: AvailabilityPoint[] = days.map((date, d) => {
    let tracked = 0;
    let inStock = 0;
    for (const c of cells) {
      if (!isTracked(c, d)) continue;
      tracked++;
      if (c.inStock[d]) inStock++;
    }
    return {
      date,
      availabilityPct: tracked ? round((inStock / tracked) * 100, 1) : 0,
      oosCount: tracked - inStock,
      tracked,
    };
  });

  const currentPct = D ? points[D - 1]!.availabilityPct : 0;
  const avgPct = round(mean(points.map((p) => p.availabilityPct)), 1);

  // By chain / category rollups over the whole range (cell-days within lifespan).
  const chainObs = new Map<string, number>();
  const chainOos = new Map<string, number>();
  const chainName = new Map<string, string>();
  const catObs = new Map<string, number>();
  const catOos = new Map<string, number>();
  const weekdayIn = new Array<number>(7).fill(0);
  const weekdayTot = new Array<number>(7).fill(0);

  for (const c of cells) {
    chainName.set(c.supermarketId, c.supermarketName);
    const cat = c.category ?? 'Sin categoría';
    for (let d = 0; d < D; d++) {
      if (!isTracked(c, d)) continue;
      chainObs.set(c.supermarketId, (chainObs.get(c.supermarketId) ?? 0) + 1);
      catObs.set(cat, (catObs.get(cat) ?? 0) + 1);
      const wd = mondayIndex(days[d]!);
      weekdayTot[wd] = weekdayTot[wd]! + 1;
      if (c.inStock[d]) {
        weekdayIn[wd] = weekdayIn[wd]! + 1;
      } else {
        chainOos.set(c.supermarketId, (chainOos.get(c.supermarketId) ?? 0) + 1);
        catOos.set(cat, (catOos.get(cat) ?? 0) + 1);
      }
    }
  }

  const byChain: AvailabilityGroup[] = [...chainObs.keys()]
    .map((key) => {
      const obs = chainObs.get(key) ?? 0;
      const oos = chainOos.get(key) ?? 0;
      return {
        key,
        label: chainName.get(key) ?? key,
        availabilityPct: obs ? round(((obs - oos) / obs) * 100, 1) : 0,
        oosCount: oos,
      };
    })
    .sort((a, b) => a.availabilityPct - b.availabilityPct);

  const byCategory: AvailabilityGroup[] = [...catObs.keys()]
    .map((key) => {
      const obs = catObs.get(key) ?? 0;
      const oos = catOos.get(key) ?? 0;
      return {
        key,
        label: key,
        availabilityPct: obs ? round(((obs - oos) / obs) * 100, 1) : 0,
        oosCount: oos,
      };
    })
    .sort((a, b) => a.availabilityPct - b.availabilityPct);

  // Chronic: per product, find the chain where it's OOS most; report that chain's
  // OOS rate over the cell's observed lifespan. Keep rates ≥ 15%, top 8.
  const byProduct = new Map<string, Cell[]>();
  for (const c of cells) {
    const arr = byProduct.get(c.productId);
    if (arr) arr.push(c);
    else byProduct.set(c.productId, [c]);
  }

  const chronic: ChronicOosProduct[] = [];
  for (const group of byProduct.values()) {
    let worst: Cell | null = null;
    let worstOos = -1;
    let worstObserved = 0;
    for (const c of group) {
      if (c.firstRow === -1) continue;
      const observedDays = c.lastRow - c.firstRow + 1;
      let oos = 0;
      for (let d = c.firstRow; d <= c.lastRow; d++) if (!c.inStock[d]) oos++;
      if (oos > worstOos) {
        worstOos = oos;
        worstObserved = observedDays;
        worst = c;
      }
    }
    if (!worst || worstObserved <= 0) continue;
    const oosRatePct = round((worstOos / worstObserved) * 100, 1);
    if (oosRatePct < 15) continue;
    chronic.push({
      productId: worst.productId,
      name: worst.productName,
      ean: worst.ean,
      category: worst.category,
      supermarketId: worst.supermarketId,
      supermarketName: worst.supermarketName,
      oosDays: worstOos,
      oosRatePct,
    });
  }
  chronic.sort((a, b) => b.oosRatePct - a.oosRatePct);

  const weekday = weekdayTot.map((tot, wd) => ({
    weekday: wd,
    availabilityPct: tot ? round((weekdayIn[wd]! / tot) * 100, 1) : 0,
  }));

  // Does an OOS episode precede a price hike? Compare the pre-OOS observed price
  // to the first observed price after restock, over every episode.
  let episodes = 0;
  let higher = 0;
  for (const c of cells) {
    for (let d = 1; d < D; d++) {
      const enteringOos = c.inStock[d - 1] && !c.inStock[d];
      if (!enteringOos) continue;
      const pre = c.observed[d - 1];
      if (pre == null) continue;
      let r = d + 1;
      while (r < D && !c.inStock[r]) r++;
      if (r >= D) continue;
      const post = c.observed[r];
      if (post == null) continue;
      episodes++;
      if (post > pre * 1.01) higher++;
    }
  }
  const oosPrecedesHikePct = episodes >= 20 ? round((higher / episodes) * 100, 0) : null;

  return {
    points,
    currentPct,
    avgPct,
    byChain,
    byCategory,
    chronic: chronic.slice(0, 8),
    weekday,
    oosPrecedesHikePct,
  };
}

function buildMovers(cells: Cell[], days: string[], windowDays: number): MoversAnalytics {
  const D = days.length;
  const win = Math.max(1, Math.min(windowDays, D - 1));

  const all: PriceMover[] = [];
  if (D >= 2) {
    for (const c of cells) {
      const from = c.carry[D - 1 - win];
      const to = c.carry[D - 1];
      if (from == null || from <= 0 || to == null) continue;
      all.push({
        productId: c.productId,
        name: c.productName,
        ean: c.ean,
        category: c.category,
        supermarketId: c.supermarketId,
        supermarketName: c.supermarketName,
        fromPrice: round(from, 2),
        toPrice: round(to, 2),
        changePct: round((to / from - 1) * 100, 1),
      });
    }
  }

  const topIncreases = all
    .filter((m) => m.changePct > 0)
    .sort((a, b) => b.changePct - a.changePct)
    .slice(0, 6);
  const topDecreases = all
    .filter((m) => m.changePct < 0)
    .sort((a, b) => a.changePct - b.changePct)
    .slice(0, 6);

  // Volatility: per product, coefficient of variation of the chain-averaged
  // carried price series over the range.
  const byProduct = new Map<string, Cell[]>();
  for (const c of cells) {
    const arr = byProduct.get(c.productId);
    if (arr) arr.push(c);
    else byProduct.set(c.productId, [c]);
  }

  const mostVolatile: VolatileProduct[] = [];
  for (const group of byProduct.values()) {
    const first = group[0]!;
    const series: number[] = [];
    for (let d = 0; d < D; d++) {
      const vals: number[] = [];
      for (const c of group) {
        const v = c.carry[d];
        if (v != null) vals.push(v);
      }
      if (vals.length) series.push(mean(vals));
    }
    if (series.length < 2) continue;
    const m = mean(series);
    if (m <= 0) continue;
    mostVolatile.push({
      productId: first.productId,
      name: first.productName,
      ean: first.ean,
      category: first.category,
      cvPct: round((stddev(series) / m) * 100, 1),
      minPrice: round(Math.min(...series), 2),
      maxPrice: round(Math.max(...series), 2),
    });
  }
  mostVolatile.sort((a, b) => b.cvPct - a.cvPct);

  return { windowDays: win, topIncreases, topDecreases, mostVolatile: mostVolatile.slice(0, 6) };
}

function buildCategories(cells: Cell[], days: string[]): CategoryInflation[] {
  const D = days.length;
  const byCat = new Map<string, Cell[]>();
  for (const c of cells) {
    const cat = c.category ?? 'Sin categoría';
    const arr = byCat.get(cat);
    if (arr) arr.push(c);
    else byCat.set(cat, [c]);
  }

  const out: CategoryInflation[] = [];
  for (const [category, group] of byCat) {
    // Same fixed-basket rule as the global basket: constituents observed on day 0.
    const constituents = group.filter((c) => c.observed[0] != null);
    if (constituents.length === 0) continue;

    const series: number[] = new Array<number>(D).fill(0);
    for (let d = 0; d < D; d++) {
      let s = 0;
      for (const c of constituents) s += c.carry[d] ?? 0;
      series[d] = s;
    }
    const base = series[0]!;
    if (base <= 0) continue;

    const last = series[D - 1]!;
    const changePct = round((last / base - 1) * 100, 1);
    const prior30 = D > 30 ? series[D - 31]! : 0;
    const monthlyPct =
      D > 30 && prior30 > 0 ? round((last / prior30 - 1) * 100, 1) : changePct;

    // ~13 evenly-spaced base-100 samples for a sparkline.
    const spark: number[] = [];
    const steps = Math.min(13, D);
    if (steps <= 1) {
      spark.push(round((last / base) * 100, 1));
    } else {
      for (let k = 0; k < steps; k++) {
        const d = Math.round((k / (steps - 1)) * (D - 1));
        spark.push(round((series[d]! / base) * 100, 1));
      }
    }

    const products = new Set(constituents.map((c) => c.productId)).size;
    out.push({ category, products, changePct, monthlyPct, spark });
  }

  return out.sort((a, b) => b.changePct - a.changePct);
}

function buildPromotions(cells: Cell[], days: string[]): PromotionAnalytics {
  const D = days.length;

  const points: PromoPoint[] = days.map((date, d) => {
    let priced = 0;
    let promoted = 0;
    const discs: number[] = [];
    for (const c of cells) {
      if (!c.inStock[d]) continue;
      priced++;
      if (c.onPromo[d]) {
        promoted++;
        discs.push(c.discount[d]!);
      }
    }
    return {
      date,
      promoSharePct: priced ? round((promoted / priced) * 100, 1) : 0,
      avgDiscountPct: discs.length ? round(mean(discs), 1) : 0,
    };
  });

  const chainAgg = new Map<string, { name: string; priced: number; promoted: number; discs: number[] }>();
  for (const c of cells) {
    let agg = chainAgg.get(c.supermarketId);
    if (!agg) {
      agg = { name: c.supermarketName, priced: 0, promoted: 0, discs: [] };
      chainAgg.set(c.supermarketId, agg);
    }
    for (let d = 0; d < D; d++) {
      if (!c.inStock[d]) continue;
      agg.priced++;
      if (c.onPromo[d]) {
        agg.promoted++;
        agg.discs.push(c.discount[d]!);
      }
    }
  }

  const byChain: PromoGroup[] = [...chainAgg.entries()]
    .map(([supermarketId, a]) => ({
      supermarketId,
      name: a.name,
      promoSharePct: a.priced ? round((a.promoted / a.priced) * 100, 1) : 0,
      avgDiscountPct: a.discs.length ? round(mean(a.discs), 1) : 0,
    }))
    .sort((a, b) => b.promoSharePct - a.promoSharePct);

  return {
    points,
    currentSharePct: D ? points[D - 1]!.promoSharePct : 0,
    // Range mean of the per-chain average discount depth (matches the mock).
    avgDiscountPct: byChain.length ? round(mean(byChain.map((x) => x.avgDiscountPct)), 1) : 0,
    byChain,
  };
}

/** Minimum shared products the auto-reduced default comparison aims to keep. */
const COMPETITIVENESS_MIN_SHARED = 8;
/** Auto-reduction never drops the comparison below this many chains. */
const COMPETITIVENESS_MIN_CHAINS = 3;

function buildCompetitiveness(
  cells: Cell[],
  days: string[],
  autoReduce: boolean,
): CompetitivenessAnalytics {
  const D = days.length;

  // For each (product, chain) pick the most complete cell (most days with a row).
  const perProduct = new Map<string, Map<string, Cell>>();
  const chainName = new Map<string, string>();
  for (const c of cells) {
    chainName.set(c.supermarketId, c.supermarketName);
    let byChain = perProduct.get(c.productId);
    if (!byChain) {
      byChain = new Map();
      perProduct.set(c.productId, byChain);
    }
    const existing = byChain.get(c.supermarketId);
    const rows = (cell: Cell) => cell.hasRow.filter(Boolean).length;
    if (!existing || rows(c) > rows(existing)) byChain.set(c.supermarketId, c);
  }

  // The shared product set = products present at *every* compared chain with a
  // day-0 observed price (so each chain's base-100 index is well-defined). With
  // many active chains almost no product is stocked everywhere, so the literal
  // intersection is empty. When the caller didn't pin chains (default "all"), we
  // greedily drop the sparsest chain — the one bounding the intersection — until
  // a meaningful shared basket appears. An explicit `supermarket` filter is
  // honored literally (no auto-reduction).
  const sharedFor = (chainList: string[]): Array<Map<string, Cell>> => {
    const out: Array<Map<string, Cell>> = [];
    for (const byChain of perProduct.values()) {
      const ok = chainList.every((ch) => {
        const cell = byChain.get(ch);
        return cell != null && cell.carry[0] != null;
      });
      if (ok) out.push(byChain);
    }
    return out;
  };

  // Day-0 product count per chain (used to pick the sparsest chain to drop).
  const chainProductCount = new Map<string, number>();
  for (const byChain of perProduct.values()) {
    for (const [ch, cell] of byChain) {
      if (cell.carry[0] != null) {
        chainProductCount.set(ch, (chainProductCount.get(ch) ?? 0) + 1);
      }
    }
  }

  let candidates = [...chainName.keys()].sort();
  let shared = sharedFor(candidates);
  if (autoReduce) {
    while (
      shared.length < COMPETITIVENESS_MIN_SHARED &&
      candidates.length > COMPETITIVENESS_MIN_CHAINS
    ) {
      // Drop the chain carrying the fewest day-0 products — it bounds the
      // intersection, so removing it gives the shared set the best chance to grow.
      let sparsest = candidates[0]!;
      for (const ch of candidates) {
        if ((chainProductCount.get(ch) ?? 0) < (chainProductCount.get(sparsest) ?? 0)) {
          sparsest = ch;
        }
      }
      candidates = candidates.filter((ch) => ch !== sparsest);
      shared = sharedFor(candidates);
    }
  }

  const allChains = candidates;

  if (shared.length === 0 || allChains.length < 2) {
    return { chains: [], points: [], dispersionPoints: [], ranking: [] };
  }

  // Per-chain basket over the shared products.
  const chainBasket = new Map<string, number[]>();
  for (const ch of allChains) {
    const arr = new Array<number>(D).fill(0);
    for (let d = 0; d < D; d++) {
      let s = 0;
      for (const byChain of shared) s += byChain.get(ch)!.carry[d] ?? 0;
      arr[d] = s;
    }
    chainBasket.set(ch, arr);
  }

  const points: ChainBasketPoint[] = days.map((date, d) => {
    const byChain: Record<string, number> = {};
    for (const ch of allChains) {
      const arr = chainBasket.get(ch)!;
      byChain[ch] = arr[0]! > 0 ? round((arr[d]! / arr[0]!) * 100, 2) : 0;
    }
    return { date, byChain };
  });

  const dispersionPoints = days.map((date, d) => {
    const spreads: number[] = [];
    for (const byChain of shared) {
      let min = Infinity;
      let max = -Infinity;
      for (const ch of allChains) {
        const v = byChain.get(ch)!.carry[d];
        if (v == null) continue;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      if (min > 0 && Number.isFinite(max)) spreads.push(((max - min) / min) * 100);
    }
    return { date, dispersionPct: round(mean(spreads), 1) };
  });

  // Cheapest-basket day count per chain.
  const cheapestDays = new Map<string, number>();
  for (const ch of allChains) cheapestDays.set(ch, 0);
  for (let d = 0; d < D; d++) {
    let best: string | null = null;
    let bestVal = Infinity;
    for (const ch of allChains) {
      const v = chainBasket.get(ch)![d]!;
      if (v < bestVal) {
        bestVal = v;
        best = ch;
      }
    }
    if (best) cheapestDays.set(best, (cheapestDays.get(best) ?? 0) + 1);
  }

  const ranking: ChainRanking[] = allChains
    .map((ch) => ({
      supermarketId: ch,
      name: chainName.get(ch) ?? ch,
      avgBasket: round(mean(chainBasket.get(ch)!), 0),
      cheapestDays: cheapestDays.get(ch) ?? 0,
      rank: 0,
    }))
    .sort((a, b) => a.avgBasket - b.avgBasket)
    .map((r, i) => ({ ...r, rank: i + 1 }));

  return {
    chains: allChains.map((ch) => ({ supermarketId: ch, name: chainName.get(ch) ?? ch })),
    points,
    dispersionPoints,
    ranking,
  };
}

// ---------------------------------------------------------------------------
// Public entry point (+ short-lived in-memory cache)
// ---------------------------------------------------------------------------

/**
 * The overview is a heavy aggregation (tens of thousands of snapshots) but is
 * read once per page load. Cache the computed payload per normalized
 * (from, to, window, supermarket) for a few minutes so repeated loads and range
 * toggles are instant, while newly-published days still show up promptly.
 */
const CACHE_TTL_MS = 10 * 60 * 1000;
const overviewCache = new Map<string, { at: number; value: AnalyticsOverview }>();

/**
 * Build the full analytics overview for the given window, memoized for
 * {@link CACHE_TTL_MS}. See {@link computeAnalyticsOverview} for the algorithm.
 */
export async function buildAnalyticsOverview(
  params: AnalyticsOverviewParams,
): Promise<AnalyticsOverview> {
  const key = JSON.stringify({
    from: params.from ?? null,
    to: params.to ?? null,
    window: params.window ?? null,
    supermarket: params.supermarket
      ? params.supermarket
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
          .sort()
          .join(',')
      : null,
  });

  const hit = overviewCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const value = await computeAnalyticsOverview(params);
  overviewCache.set(key, { at: Date.now(), value });
  // Drop stale entries so the map can't grow unbounded over a long-lived process.
  for (const [k, v] of overviewCache) {
    if (Date.now() - v.at >= CACHE_TTL_MS) overviewCache.delete(k);
  }
  return value;
}

/**
 * Reads the published snapshot set, buckets it by BA calendar day, and rolls it
 * up into the six analytics sections. Returns a zeroed (but well-shaped) payload
 * when the window has no data, so the UI degrades gracefully.
 */
async function computeAnalyticsOverview(
  params: AnalyticsOverviewParams,
): Promise<AnalyticsOverview> {
  const today = todayInBuenosAires();
  const windowDays = params.window && params.window > 0 ? Math.floor(params.window) : 30;

  // Resolve the requested window, honoring the same hard client-data floor as
  // /v1/data/pricing so analytics can never surface pre-floor data.
  const requestedTo = params.to ?? today;
  let requestedFrom = params.from ?? addDays(today, -119);
  if (requestedFrom < CLIENT_DATA_FLOOR_DATE) requestedFrom = CLIENT_DATA_FLOOR_DATE;

  if (requestedFrom > requestedTo) {
    return emptyOverview(requestedFrom, requestedTo, windowDays);
  }

  const supermarketIds = params.supermarket
    ? params.supermarket
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    : null;

  const rows = await fetchPublishedSnapshots(requestedFrom, requestedTo, supermarketIds);
  if (rows.length === 0) {
    return emptyOverview(requestedFrom, requestedTo, windowDays);
  }

  // Clamp the analyzed window to the days actually covered by data, so the
  // base-100 indices start on a day with a real basket value (and "today", which
  // is usually still pending review, doesn't produce a trailing empty day).
  let minDate = requestedTo;
  let maxDate = requestedFrom;
  for (const r of rows) {
    const d = baDate(new Date(r.scrapedAt));
    if (d < requestedFrom || d > requestedTo) continue;
    if (d < minDate) minDate = d;
    if (d > maxDate) maxDate = d;
  }
  if (minDate > maxDate) return emptyOverview(requestedFrom, requestedTo, windowDays);

  const days = dayRange(minDate, maxDate);
  const cells = buildPanel(rows, days);
  if (cells.length === 0) return emptyOverview(minDate, maxDate, windowDays);

  return {
    range: { from: minDate, to: maxDate, days: days.length },
    generatedAt: new Date().toISOString(),
    basket: buildBasket(cells, days),
    availability: buildAvailability(cells, days),
    movers: buildMovers(cells, days, windowDays),
    categories: buildCategories(cells, days),
    promotions: buildPromotions(cells, days),
    // Auto-reduce the compared chains only when the caller didn't pin a set.
    competitiveness: buildCompetitiveness(cells, days, supermarketIds === null),
  };
}
