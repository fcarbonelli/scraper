/**
 * Banco Santander promotions provider.
 *
 * Santander's benefits SPA (`santander.com.ar/…/beneficios/compras`) is backed
 * by a **same-origin** BFF (`www.santander.com.ar/bff-benefits`) that sits
 * behind the site's WAF (plain `fetch` hangs/blocks). We use the shared
 * {@link withPageFetcher}: drive a real Chromium onto the beneficios page, then
 * call the BFF in-page (same-origin, WAF cleared).
 *
 *   GET /bff-benefits/brands?limit=L&offset=O   → { items:[{id,name,…}], totalItems }
 *   GET /bff-benefits/brands/{id}               → { items:[ …benefit… ] } (the
 *       actual promos for that merchant: customerDiscount, topAmount, day flags,
 *       start/endDatePublication, additionalText T&C, installments)
 *
 * The endpoint honors a large `limit` (there are ~750 brands), but offset-based
 * paging past the first page is flaky behind the WAF, so we request one big page
 * (`PAGE_LIMIT`) and still loop by offset as a backup for any overflow.
 *
 * All promos are attributed issuer='Banco Santander'.
 */

import {
  parseInstallments,
  parseYmdDate,
  stripHtml,
  weekdaysFromDayFlags,
} from './normalize.js';
import { withPageFetcher, type BrowserLaunchOptions, type PageFetcher } from './browserFetch.js';
import type {
  NormalizedPromotion,
  PromoContext,
  PromoProvider,
  PromotionPlan,
} from './types.js';

const DEFAULT_ORIGIN =
  'https://www.santander.com.ar/banco/online/personas/beneficios/compras';
const DEFAULT_BASE = 'https://www.santander.com.ar/bff-benefits';
// One big page covers the whole brand set (~750 today) in a single call, since
// offset paging is unreliable behind the WAF. The offset loop below is a backup.
const PAGE_LIMIT = 2000;
const MAX_BRAND_PAGES = 20; // safety cap on the brand list

const API_HEADERS: Record<string, string> = {
  accept: 'application/json, text/plain, */*',
};

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function str(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : v == null ? '' : String(v);
  return s.length > 0 ? s : null;
}

export const santanderProvider: PromoProvider = {
  id: 'santander',
  name: 'Banco Santander',

  async fetchAll(ctx: PromoContext): Promise<NormalizedPromotion[]> {
    const origin = str(ctx.config['origin']) ?? DEFAULT_ORIGIN;
    const base = str(ctx.config['baseUrl']) ?? DEFAULT_BASE;
    const launch = (ctx.config['launch'] as BrowserLaunchOptions | undefined) ?? {};
    const log = ctx.logger.child({ provider: 'santander' });

    return withPageFetcher(
      { origin, headers: API_HEADERS, bootMs: 6000, logger: ctx.logger, launch, signal: ctx.signal },
      async (f) => {
        // 1. Enumerate every brand (merchant) via the paged list.
        const brands = await loadBrands(f, base, ctx.signal);
        log.info({ brands: brands.length }, 'santander: brands enumerated, fetching benefits');

        // 2. Fetch each brand's benefit(s) and normalize.
        const byId = new Map<string, NormalizedPromotion>();
        for (const brand of brands) {
          if (ctx.signal?.aborted) throw new Error('aborted');
          const { status, json } = await f.getJson(`${base}/brands/${brand.id}`);
          if (status !== 200) continue;
          for (const item of asArray(asRecord(json)['items'])) {
            const promo = mapBenefit(item, brand);
            if (promo) byId.set(promo.externalId, promo);
          }
        }

        log.info({ promotions: byId.size }, 'santander: fetch complete');
        return [...byId.values()];
      },
    );
  },
};

interface Brand {
  id: string;
  name: string | null;
  image: string | null;
}

/** Page the /brands list (offset by PAGE_LIMIT) until totalItems is reached. */
async function loadBrands(
  f: PageFetcher,
  base: string,
  signal: AbortSignal | undefined,
): Promise<Brand[]> {
  const brands: Brand[] = [];
  const seen = new Set<string>();
  for (let page = 0; page < MAX_BRAND_PAGES; page++) {
    if (signal?.aborted) throw new Error('aborted');
    const offset = page * PAGE_LIMIT;
    const url = `${base}/brands?limit=${PAGE_LIMIT}&offset=${offset}`;
    const { status, json } = await f.getJson(url);
    if (status !== 200) break;
    const data = asRecord(json);
    const items = asArray(data['items']);
    if (items.length === 0) break;
    for (const raw of items) {
      const b = asRecord(raw);
      const id = str(b['id']);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      brands.push({
        id,
        name: str(b['name']),
        image: str(b['desktopImage']) ?? str(b['mobileImage']),
      });
    }
    const total = Number(data['totalItems']);
    if (Number.isFinite(total) && offset + items.length >= total) break;
    if (items.length < PAGE_LIMIT) break;
  }
  return brands;
}

/** Map one Santander brand-benefit onto a NormalizedPromotion. */
function mapBenefit(raw: unknown, brand: Brand): NormalizedPromotion | null {
  const b = asRecord(raw);
  // Prefer the stable promotion id; fall back to the item id.
  const externalId = str(b['idPromotion']) ?? str(b['id']);
  if (!externalId) return null;

  const merchant = brand.name;
  const discountNum = Number(b['customerDiscount']);
  const discountPct =
    Number.isFinite(discountNum) && discountNum > 0 && discountNum <= 100
      ? Math.round(discountNum)
      : null;
  const validFrom = parseYmdDate(b['startDatePublication']);
  const validTo = parseYmdDate(b['endDatePublication']);
  const weekdays =
    b['fullWeek'] === true ? ['ALL_DAYS'] : weekdaysFromDayFlags(b);
  const terms = stripHtml(b['additionalText']);

  // Installments: interest-free-fees flag + a finalQuote count, else parse text.
  const finalQuote = Number(b['finalQuote']);
  const installments =
    b['interestFreeFees'] === true && Number.isInteger(finalQuote) && finalQuote > 1
      ? finalQuote
      : parseInstallments(terms ?? '');
  const paymentMethods: string[] =
    b['interestFreeFees'] === true || (installments ?? 0) > 1 ? ['CREDITO'] : [];

  const title = discountPct
    ? `${discountPct}% en ${merchant ?? 'Santander'}`
    : merchant ?? `Beneficio ${externalId}`;

  const plan: PromotionPlan = {
    title,
    paymentMethods,
    weekdays,
    validFrom,
    validTo,
    appliesOnline: null,
    discountPct,
    installments,
  };

  const tags: unknown[] = [];
  const topAmount = Number(b['topAmount']);
  if (Number.isFinite(topAmount) && topAmount > 0) {
    tags.push({ type: 'cap', description: `Tope $${topAmount}` });
  }
  if (b['interestFreeFees'] === true) {
    tags.push({ type: 'flag', description: 'Cuotas sin interés' });
  }

  return {
    providerId: 'santander',
    externalId,
    title,
    issuer: 'Banco Santander',
    merchant,
    category: null,
    categoryName: null,
    subcategory: null,
    subtitle: terms,
    paymentMethods,
    weekdays,
    purchaseModes: [],
    maxDiscountPct: discountPct,
    maxInstallments: installments,
    validFrom,
    validTo,
    url: null,
    fullUrl: null,
    logoUrl: brand.image,
    imageUrl: brand.image,
    isFeatured: false,
    plans: [plan],
    tags,
    raw: b,
  };
}
