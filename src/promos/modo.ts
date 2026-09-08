/**
 * MODO promotions provider — the aggregator "hub".
 *
 * MODO (modo.com.ar/promos) is a Next.js SPA that lists the promotions of
 * ~80 Argentine banks/wallets in a single searchable catalog. It is backed by a
 * public BFF proxied on the site's own origin, so we hit it directly — no HTML
 * parsing, no AI, no browser. All endpoints are public (realistic browser
 * headers are enough):
 *
 *   GET /promos/api/rewards/categories       → taxonomy (id → slug/title)
 *   GET /promos/api/rewards/slots?source=hub&page=N
 *                                            → the full paged promotions list
 *                                              ({ data:{ cards:[…] }, metadata:{ pagination } })
 *
 * One adapter here covers every bank's *pay-with-MODO* promo, so `issuer` (the
 * bank behind each card) is the key dimension we extract. Pagination is 10
 * cards/page over thousands of pages, so we fan out with a small concurrency
 * pool to stay well inside the run timeout.
 */

import {
  maxIso,
  minIso,
  parseDiscountPct,
  parseInstallments,
  paymentMethodsFromCardLists,
  purchaseModesFromFlow,
  weekdaysFromLetters,
} from './normalize.js';
import type {
  NormalizedPromotion,
  PromoContext,
  PromoProvider,
  PromotionPlan,
} from './types.js';

const DEFAULT_BASE_URL = 'https://www.modo.com.ar/promos/api/rewards';
const DEFAULT_SOURCE = 'hub';

/** Realistic browser headers — the origin 403s obvious bots otherwise. */
const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
  Referer: 'https://www.modo.com.ar/promos',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'es-AR,es;q=0.9',
};

/** How many pages to request in parallel (politeness vs. run time). */
const CONCURRENCY = 6;
/** Absolute safety cap so a runaway pager can never loop forever. */
const MAX_PAGES = 6000;

// ---- tiny, defensive readers over unknown JSON --------------------------------

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

// ---- provider -----------------------------------------------------------------

export const modoProvider: PromoProvider = {
  id: 'modo',
  name: 'MODO',

  async fetchAll(ctx: PromoContext): Promise<NormalizedPromotion[]> {
    const baseUrl = str(ctx.config['baseUrl']) ?? DEFAULT_BASE_URL;
    const source = str(ctx.config['source']) ?? DEFAULT_SOURCE;
    const maxPagesCfg = Number(ctx.config['maxPages']);
    const pageCap =
      Number.isInteger(maxPagesCfg) && maxPagesCfg > 0 ? maxPagesCfg : MAX_PAGES;
    const log = ctx.logger.child({ provider: 'modo' });

    const categoryById = await loadCategoryMap(baseUrl, ctx.signal, log);
    const banks = await loadBankNames(baseUrl, ctx.signal, log);

    // First page tells us the total page count from the pagination metadata.
    const first = await fetchSlotsPage(baseUrl, source, 1, ctx.signal);
    const totalPages = Math.min(first.totalPages, pageCap);
    log.info(
      { totalPromotions: first.totalResults, totalPages },
      'modo: paging the hub catalog',
    );

    // De-dup by card id (the API's stable promo key) across pages.
    const byId = new Map<string, NormalizedPromotion>();
    for (const card of first.cards) {
      const promo = mapCard(card, categoryById, banks);
      if (promo) byId.set(promo.externalId, promo);
    }

    // Fan out the remaining pages in fixed-size concurrent batches.
    for (let start = 2; start <= totalPages; start += CONCURRENCY) {
      if (ctx.signal?.aborted) throw new Error('aborted');
      const batch: number[] = [];
      for (let p = start; p < start + CONCURRENCY && p <= totalPages; p++) {
        batch.push(p);
      }
      const results = await Promise.all(
        batch.map((p) => fetchSlotsPage(baseUrl, source, p, ctx.signal)),
      );
      for (const r of results) {
        for (const card of r.cards) {
          const promo = mapCard(card, categoryById, banks);
          if (promo) byId.set(promo.externalId, promo);
        }
      }
      if (start % 200 < CONCURRENCY) {
        log.debug({ page: start, running: byId.size }, 'modo: paging progress');
      }
    }

    log.info({ promotions: byId.size }, 'modo: fetch complete');
    return [...byId.values()];
  },
};

// ---- mapping ------------------------------------------------------------------

interface CategoryInfo {
  key: string; // slug uppercased, e.g. "MERCADOS"
  name: string; // title, e.g. "Mercados"
}

/**
 * Map one MODO "card" onto a NormalizedPromotion. Cards without a stable id or
 * any title are skipped (defensive against pure decorative slots).
 */
function mapCard(
  raw: unknown,
  categoryById: Map<number, CategoryInfo>,
  banks: string[],
): NormalizedPromotion | null {
  const c = asRecord(raw);
  const externalId = str(c['id']);
  const title = str(c['title']);
  if (!externalId || !title) return null;

  const content = asRecord(c['content']);
  const rows = asArray(content['row']).map(asRecord);
  const rowTexts = rows.map((r) => str(r['text'])).filter((t): t is string => !!t);

  // Banks explicitly adhered to a cross-bank promo (from `extra_data`).
  const adheredBanks: string[] = [];
  for (const row of rows) {
    for (const bank of asArray(row['extra_data'])) {
      const name = str(asRecord(bank)['name_bank']);
      if (name) adheredBanks.push(name);
    }
  }
  const { issuer, adhered } = resolveIssuer(adheredBanks, rowTexts, title, banks);

  // Discount / installments: parse from the title + all row texts.
  const textBlob = [title, ...rows.map((r) => str(r['text']) ?? '')].join(' ');
  const discountPct = parseDiscountPct(textBlob);
  const installments = parseInstallments(textBlob);

  const paymentMethods = paymentMethodsFromCardLists(
    c['debit_list'],
    c['credit_list'],
  );
  const weekdays = weekdaysFromLetters(c['days_of_week']);
  const purchaseModes = purchaseModesFromFlow(c['payment_flow']);

  const validFrom = isoOrNull(c['start_date']);
  const validTo = isoOrNull(c['stop_date']);

  const category = resolveCategory(c, categoryById);
  const image = asRecord(content['image']);

  // One synthetic plan keeps parity with the multi-plan providers. The full
  // card lives once in the top-level `raw`, so the plan omits it (no dup at 26k rows).
  const plan: PromotionPlan = {
    title,
    paymentMethods,
    weekdays,
    validFrom,
    validTo,
    appliesOnline: purchaseModes.includes('ONLINE') ? true : null,
    discountPct,
    installments,
  };

  return {
    providerId: 'modo',
    externalId,
    title,
    issuer,
    merchant: null, // MODO promos are network/category-wide, not per-commerce
    category: category?.key ?? null,
    categoryName: category?.name ?? null,
    subcategory: null,
    subtitle: str(c['where']) ?? str(c['short_description']),
    paymentMethods,
    weekdays,
    purchaseModes,
    maxDiscountPct: discountPct,
    maxInstallments: installments,
    validFrom: minIso([validFrom]),
    validTo: maxIso([validTo]),
    url: null,
    fullUrl: null,
    logoUrl: null,
    imageUrl: str(image['primary_image']),
    isFeatured: false,
    plans: [plan],
    tags: adhered.length > 0 ? [{ adheredBanks: adhered }] : [],
    raw: c,
  };
}

/**
 * Resolve the issuing bank for a card. Priority:
 *   1. A single adhered bank (from extra_data) → that bank.
 *   2. Several adhered banks → "MODO" (cross-bank), keep the list.
 *   3. A row text or the title that matches a known bank name → that bank.
 *   4. Otherwise null (never a stray label like "Exclusivo con").
 */
function resolveIssuer(
  adheredBanks: string[],
  rowTexts: string[],
  title: string,
  banks: string[],
): { issuer: string | null; adhered: string[] } {
  const adhered = [...new Set(adheredBanks)];
  if (adhered.length === 1) return { issuer: adhered[0]!, adhered: [] };
  if (adhered.length > 1) return { issuer: 'MODO', adhered };

  // Match a known bank name in the row texts first (most specific), then title.
  for (const text of [...rowTexts, title]) {
    const hit = matchKnownBank(text, banks);
    if (hit) return { issuer: hit, adhered: [] };
  }
  return { issuer: null, adhered: [] };
}

/** Return the canonical known-bank name that best matches `text`, or null. */
function matchKnownBank(text: string, banks: string[]): string | null {
  const lower = text.toLowerCase();
  // Exact match wins.
  for (const b of banks) {
    if (b.toLowerCase() === lower) return b;
  }
  // Otherwise a whole-name substring match (longest first to prefer specifics).
  for (const b of [...banks].sort((a, z) => z.length - a.length)) {
    if (b.length >= 4 && lower.includes(b.toLowerCase())) return b;
  }
  return null;
}

/** Coerce an ISO-ish date string to a normalized ISO string (or null). */
function isoOrNull(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * Resolve a card's whitelisted category to a taxonomy key/name. MODO uses
 * `categories_whitelist.categories[].map_category` ids; 0 means "all" (null).
 */
function resolveCategory(
  card: Record<string, unknown>,
  categoryById: Map<number, CategoryInfo>,
): CategoryInfo | null {
  const whitelist = asRecord(card['categories_whitelist']);
  for (const entry of asArray(whitelist['categories'])) {
    const id = Number(asRecord(entry)['map_category']);
    if (Number.isInteger(id) && id > 0) {
      const info = categoryById.get(id);
      if (info) return info;
    }
  }
  return null;
}

// ---- HTTP ---------------------------------------------------------------------

interface SlotsPage {
  cards: unknown[];
  totalPages: number;
  totalResults: number;
}

/** Fetch one page of the hub catalog. */
async function fetchSlotsPage(
  baseUrl: string,
  source: string,
  page: number,
  signal?: AbortSignal,
): Promise<SlotsPage> {
  const url = `${baseUrl}/slots?source=${encodeURIComponent(source)}&page=${page}`;
  const res = await getJson(url, signal);
  const data = asRecord(res['data']);
  const pagination = asRecord(asRecord(res['metadata'])['pagination']);
  return {
    cards: asArray(data['cards']),
    totalPages: Number(pagination['total_pages'] ?? 1),
    totalResults: Number(pagination['total_results'] ?? 0),
  };
}

/** Fetch the category taxonomy as an id → {key,name} map (best-effort). */
async function loadCategoryMap(
  baseUrl: string,
  signal: AbortSignal | undefined,
  log: PromoContext['logger'],
): Promise<Map<number, CategoryInfo>> {
  const map = new Map<number, CategoryInfo>();
  try {
    const res = await fetch(`${baseUrl}/categories`, {
      headers: BROWSER_HEADERS,
      signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const list = (await res.json()) as unknown[];
    for (const item of asArray(list)) {
      const rec = asRecord(item);
      const id = Number(rec['id']);
      const slug = str(rec['slug']);
      const title = str(rec['title']);
      if (Number.isInteger(id) && (slug || title)) {
        map.set(id, {
          key: (slug ?? title ?? '').toUpperCase(),
          name: title ?? slug ?? '',
        });
      }
    }
  } catch (err) {
    log.warn({ err }, 'modo: category lookup failed (continuing without names)');
  }
  return map;
}

/** Fetch the list of known bank names (used to resolve each card's issuer). */
async function loadBankNames(
  baseUrl: string,
  signal: AbortSignal | undefined,
  log: PromoContext['logger'],
): Promise<string[]> {
  try {
    const res = await fetch(`${baseUrl}/banks?source=${DEFAULT_SOURCE}`, {
      headers: BROWSER_HEADERS,
      signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const list = (await res.json()) as unknown[];
    const names = new Set<string>();
    for (const item of asArray(list)) {
      const name = str(asRecord(item)['name']);
      if (name) names.add(name);
    }
    return [...names];
  } catch (err) {
    log.warn({ err }, 'modo: bank lookup failed (issuer resolution degraded)');
    return [];
  }
}

async function getJson(
  url: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const res = await fetch(url, { method: 'GET', headers: BROWSER_HEADERS, signal });
  if (!res.ok) {
    throw new Error(`GET ${url} → HTTP ${res.status}`);
  }
  return (await res.json()) as Record<string, unknown>;
}
