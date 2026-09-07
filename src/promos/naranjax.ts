/**
 * Naranja X promotions provider.
 *
 * Naranja X's promos page (naranjax.com/promociones) is an Angular SPA, but it
 * is backed by a clean JSON BFF. We hit that BFF directly — no HTML parsing, no
 * AI, no browser. All endpoints used here are public (they only need realistic
 * browser headers; without them Cloudflare serves a challenge page):
 *
 *   GET  /data-for-filter                      → taxonomy (category keys, etc.)
 *   GET  /aspects/featured                     → homepage carousel (for is_featured)
 *   POST /binder/filter   {filters,pageOptions}→ the full promo list, paged, per category
 *
 * Enumeration strategy: iterate every active category key and page through
 * /binder/filter. Each returned "binder" is a commerce card that bundles one or
 * more promo "plans" (e.g. "25% off" + "12 cuotas cero interés"); we store one
 * `promotions` row per binder with its plans kept losslessly.
 */

import { promosConfig } from './config.js';
import {
  maxIso,
  minIso,
  normalizePaymentMethods,
  parseArDate,
  parseDiscountPct,
  parseInstallments,
  weekdaysFromApplied,
} from './normalize.js';
import type {
  NormalizedPromotion,
  PromoContext,
  PromoProvider,
  PromotionPlan,
} from './types.js';

const DEFAULT_BASE_URL =
  'https://bkn-promotions.naranjax.com/bff-promotions-web/api';

/** Realistic browser headers — required to pass Cloudflare on the public BFF. */
const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
  Origin: 'https://www.naranjax.com',
  Referer: 'https://www.naranjax.com/promociones/',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'es-AR,es;q=0.9',
};

const PAGE_SIZE = 50;
const MAX_PAGES_PER_CATEGORY = 200; // hard safety cap against a runaway pager

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- provider -----------------------------------------------------------------

export const naranjaxProvider: PromoProvider = {
  id: 'naranjax',
  name: 'Naranja X',

  async fetchAll(ctx: PromoContext): Promise<NormalizedPromotion[]> {
    const baseUrl = str(ctx.config['baseUrl']) ?? DEFAULT_BASE_URL;
    const log = ctx.logger.child({ provider: 'naranjax' });

    const categories = await loadCategoryKeys(baseUrl, ctx.signal);
    log.info({ categories: categories.length }, 'naranjax: loaded categories');

    const featuredSlugs = await loadFeaturedSlugs(baseUrl, ctx, log);

    // De-dup across categories by binder id (a binder belongs to one category,
    // but upserting is cheap and keeps us safe if that ever changes).
    const byId = new Map<string, NormalizedPromotion>();

    for (const category of categories) {
      let page = 1;
      for (;;) {
        if (ctx.signal?.aborted) throw new Error('aborted');
        const body = {
          filters: { categories: [{ key: category }] },
          pageOptions: { page, size: PAGE_SIZE },
        };
        const res = await postJson(`${baseUrl}/binder/filter`, body, ctx.signal);
        const data = asArray(res['data']);
        const info = asRecord(res['info']);
        const total = Number(info['total'] ?? 0);

        for (const item of data) {
          const promo = mapBinder(item, category, featuredSlugs);
          if (promo) byId.set(promo.externalId, promo);
        }

        const seen = page * PAGE_SIZE;
        if (data.length < PAGE_SIZE || seen >= total || page >= MAX_PAGES_PER_CATEGORY) {
          break;
        }
        page += 1;
        await sleep(promosConfig.requestDelayMs);
      }
      log.debug({ category, running: byId.size }, 'naranjax: category done');
      await sleep(promosConfig.requestDelayMs);
    }

    return [...byId.values()];
  },
};

/** Category keys marked active in the taxonomy (/data-for-filter). */
async function loadCategoryKeys(
  baseUrl: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const res = await getJson(`${baseUrl}/data-for-filter`, signal);
  const cats = asArray(res['categories']);
  const keys: string[] = [];
  for (const c of cats) {
    const rec = asRecord(c);
    const key = str(rec['key']);
    const active = rec['active'];
    if (key && active !== false) keys.push(key);
  }
  return keys;
}

/**
 * Build a lowercase set of commerce slugs that currently appear in the homepage
 * carousel, so we can flag matching binders as featured. Best-effort: a miss
 * just leaves is_featured=false.
 */
async function loadFeaturedSlugs(
  baseUrl: string,
  ctx: PromoContext,
  log: PromoContext['logger'],
): Promise<Set<string>> {
  const slugs = new Set<string>();
  try {
    const res = await getJson(`${baseUrl}/aspects/featured`, ctx.signal);
    const list = Array.isArray(res) ? res : asArray(asRecord(res)['data']);
    for (const item of list) {
      const link = str(asRecord(item)['link']);
      if (!link) continue;
      for (const seg of link.split('/')) {
        const s = seg.trim().toLowerCase();
        if (s && !s.startsWith('http') && s !== 'promociones') slugs.add(s);
      }
    }
  } catch (err) {
    log.warn({ err }, 'naranjax: featured lookup failed (continuing without it)');
  }
  return slugs;
}

/** Map one raw binder (commerce card) to a NormalizedPromotion. */
function mapBinder(
  raw: unknown,
  categoryKeyFilter: string,
  featuredSlugs: Set<string>,
): NormalizedPromotion | null {
  const b = asRecord(raw);
  const externalId = str(b['id']);
  if (!externalId) return null;

  const cat = asRecord(b['category']);
  const sub = asRecord(cat['subcategory']);
  const url = str(b['url']);

  const rawPlans = asArray(b['plans']);
  const plans: PromotionPlan[] = rawPlans.map((p) => {
    const plan = asRecord(p);
    const days = asRecord(plan['days']);
    const details = asRecord(plan['promotionDetails']);
    const title = str(plan['title']) ?? '';
    const appliesOnline =
      typeof details['appliesOnline'] === 'boolean'
        ? (details['appliesOnline'] as boolean)
        : null;
    return {
      title,
      paymentMethods: normalizePaymentMethods(plan['paymentMethods']),
      weekdays: weekdaysFromApplied(days['weekdaysApplied']),
      validFrom: parseArDate(days['dateFrom']),
      validTo: parseArDate(days['dateTo']),
      appliesOnline,
      discountPct: parseDiscountPct(title),
      installments: parseInstallments(title),
      raw: plan,
    };
  });

  // Aggregate across plans.
  const paymentMethods = new Set<string>(normalizePaymentMethods(b['paymentMethods']));
  const weekdays = new Set<string>();
  const purchaseModes = new Set<string>();
  let maxDiscountPct: number | null = null;
  let maxInstallments: number | null = null;
  for (const p of plans) {
    p.paymentMethods.forEach((m) => paymentMethods.add(m));
    p.weekdays.forEach((d) => weekdays.add(d));
    if (p.appliesOnline === true) purchaseModes.add('ONLINE');
    if (p.appliesOnline === false) purchaseModes.add('IN_STORE');
    if (p.discountPct != null) maxDiscountPct = Math.max(maxDiscountPct ?? 0, p.discountPct);
    if (p.installments != null) maxInstallments = Math.max(maxInstallments ?? 0, p.installments);
  }

  const isFeatured = url ? featuredSlugs.has(url.toLowerCase()) : false;

  return {
    providerId: 'naranjax',
    externalId,
    title: str(b['title']),
    merchant: str(b['commerceName']),
    category: str(cat['key']) ?? categoryKeyFilter,
    categoryName: str(cat['name']),
    subcategory: str(sub['key']),
    subtitle: str(b['subtitle']),
    paymentMethods: [...paymentMethods],
    weekdays: [...weekdays],
    purchaseModes: [...purchaseModes],
    maxDiscountPct,
    maxInstallments,
    validFrom: minIso(plans.map((p) => p.validFrom)),
    validTo: maxIso(plans.map((p) => p.validTo)),
    url,
    fullUrl: str(b['fullUrl']),
    logoUrl: str(b['logo']),
    imageUrl: str(b['backgroundImage']),
    isFeatured,
    plans,
    tags: asArray(b['tags']),
    raw: b,
  };
}

// ---- HTTP ---------------------------------------------------------------------

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

async function postJson(
  url: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...BROWSER_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    throw new Error(`POST ${url} → HTTP ${res.status}`);
  }
  return (await res.json()) as Record<string, unknown>;
}
