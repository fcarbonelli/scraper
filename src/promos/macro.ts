/**
 * Banco Macro promotions provider.
 *
 * Macro's benefits SPA (`macro.com.ar/beneficios`) sits behind an F5 WAF (the
 * `/TSPD/` JS challenge) that blocks plain `fetch`, and its API
 * (`apipublic.macro.com.ar/v1/card-benefits`) additionally requires a public
 * `apikey` header the SPA injects. So we use the shared {@link withPageFetcher}:
 * drive a real Chromium (which clears the JS challenge), capture the `apikey`
 * from the app's own request (in-memory, never logged), and replay the paginated
 * API in-page.
 *
 * Promotions are served **per province** (ISO 3166-2:AR codes), paginated by
 * `offset`:
 *   GET /v1/card-benefits/categories                       → id → display-name
 *   GET /v1/card-benefits/provinces/{code}?offset=N         → { promotions: [ … ] }
 *
 * A national promo appears under many provinces, so we de-dupe by a stable key.
 * All promos are attributed issuer='Banco Macro'.
 */

import { weekdaysFromDayFlags } from './normalize.js';
import { withPageFetcher, type BrowserLaunchOptions } from './browserFetch.js';
import type {
  NormalizedPromotion,
  PromoContext,
  PromoProvider,
  PromotionPlan,
} from './types.js';

const DEFAULT_ORIGIN = 'https://www.macro.com.ar/beneficios';
const DEFAULT_BASE = 'https://apipublic.macro.com.ar/v1/card-benefits';

const API_HEADERS: Record<string, string> = {
  accept: 'application/json, text/plain, */*',
};

/** ISO 3166-2:AR province codes Macro's API accepts (AR-B = Buenos Aires, …). */
const PROVINCE_CODES = [
  'AR-A', 'AR-B', 'AR-C', 'AR-D', 'AR-E', 'AR-F', 'AR-G', 'AR-H', 'AR-J',
  'AR-K', 'AR-L', 'AR-M', 'AR-N', 'AR-P', 'AR-Q', 'AR-R', 'AR-S', 'AR-T',
  'AR-U', 'AR-V', 'AR-W', 'AR-X', 'AR-Y', 'AR-Z',
];

const MAX_OFFSET_PAGES = 100; // per-province safety cap

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
/** Read a field trying several possible key spellings (kebab/camel/snake). */
function pick(o: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) if (o[k] != null) return o[k];
  return null;
}

export const macroProvider: PromoProvider = {
  id: 'macro',
  name: 'Banco Macro',

  async fetchAll(ctx: PromoContext): Promise<NormalizedPromotion[]> {
    const origin = str(ctx.config['origin']) ?? DEFAULT_ORIGIN;
    const base = str(ctx.config['baseUrl']) ?? DEFAULT_BASE;
    const launch = (ctx.config['launch'] as BrowserLaunchOptions | undefined) ?? {};
    // Optional subset of provinces (config.provinces) — else all 24.
    const provinces =
      Array.isArray(ctx.config['provinces']) && ctx.config['provinces'].length > 0
        ? (ctx.config['provinces'] as string[])
        : PROVINCE_CODES;
    const log = ctx.logger.child({ provider: 'macro' });

    return withPageFetcher(
      {
        origin,
        headers: API_HEADERS,
        captureHeaders: { urlIncludes: 'apipublic.macro.com.ar', names: ['apikey'] },
        bootMs: 6000,
        logger: ctx.logger,
        launch,
        signal: ctx.signal,
      },
      async (f) => {
        const byId = new Map<string, NormalizedPromotion>();
        for (const province of provinces) {
          if (ctx.signal?.aborted) throw new Error('aborted');
          const before = byId.size;
          for (let offset = 1; offset <= MAX_OFFSET_PAGES; offset++) {
            const url = `${base}/provinces/${province}?offset=${offset}`;
            const { status, json } = await f.getJson(url);
            if (status !== 200) break; // province exhausted / not served
            const list = asArray(asRecord(json)['promotions']);
            if (list.length === 0) break;
            for (const item of list) {
              const promo = mapItem(item, province);
              if (!promo) continue;
              // A national merchant repeats across provinces: merge the province
              // into the existing row instead of creating a duplicate.
              const existing = byId.get(promo.externalId);
              if (existing) mergeProvince(existing, province);
              else byId.set(promo.externalId, promo);
            }
          }
          log.debug({ province, added: byId.size - before, total: byId.size }, 'macro: province done');
        }

        log.info({ promotions: byId.size }, 'macro: fetch complete');
        return [...byId.values()];
      },
    );
  },
};

/**
 * Map one Macro promotion onto a NormalizedPromotion. Macro's item shape:
 *   { name, province-code, logo, segment, highlighted, discount (number|null),
 *     sector (category name), payment:{ minimum, maximum, method:"TC"|"TD" },
 *     days-week:{ monday..sunday: bool } }
 * There's no promo id, so we key by merchant+sector+discount+method (province-
 * agnostic) to collapse the same national merchant seen across provinces.
 */
function mapItem(
  raw: unknown,
  province: string,
): NormalizedPromotion | null {
  const p = asRecord(raw);
  const name = str(pick(p, 'name'));
  if (!name) return null;

  const categoryName = str(pick(p, 'sector', 'category'));
  const segment = str(pick(p, 'segment'));
  const discountNum = Number(pick(p, 'discount'));
  const discountPct =
    Number.isFinite(discountNum) && discountNum > 0 && discountNum <= 100
      ? Math.round(discountNum)
      : null;

  const payment = asRecord(pick(p, 'payment'));
  const paymentMethods = paymentMethodsFromMacroMethod(str(payment['method']));
  const maxNum = Number(payment['maximum']);
  const installments = Number.isInteger(maxNum) && maxNum > 1 ? maxNum : null;

  const weekdays = weekdaysFromDayFlags(pick(p, 'days-week'));
  const logo = str(pick(p, 'logo'));

  // Card headline: "<discount>% en <merchant>" when a discount exists, else the
  // merchant name (many Macro promos are installment-only, discount=null).
  const title = discountPct ? `${discountPct}% en ${name}` : name;
  const externalId = [name, categoryName ?? '', discountPct ?? '', payment['method'] ?? '']
    .join('|')
    .toLowerCase();

  const plan: PromotionPlan = {
    title,
    paymentMethods,
    weekdays,
    validFrom: null,
    validTo: null,
    appliesOnline: null,
    discountPct,
    installments,
  };

  const tags: unknown[] = [];
  if (segment) tags.push({ type: 'segment', description: segment });
  if (p['highlighted'] === true) tags.push({ type: 'flag', description: 'Destacado' });
  tags.push({ type: 'provinces', description: province, provinces: [province] });

  return {
    providerId: 'macro',
    externalId,
    title,
    issuer: 'Banco Macro',
    merchant: name,
    category: null,
    categoryName,
    subcategory: null,
    subtitle: name,
    paymentMethods,
    weekdays,
    purchaseModes: [],
    maxDiscountPct: discountPct,
    maxInstallments: installments,
    validFrom: null,
    validTo: null,
    url: null,
    fullUrl: null,
    logoUrl: logo,
    imageUrl: logo,
    isFeatured: p['highlighted'] === true,
    plans: [plan],
    tags,
    raw: p,
  };
}

/** Merge an extra province into an existing promo's `provinces` tag. */
function mergeProvince(promo: NormalizedPromotion, province: string): void {
  const tag = promo.tags.find(
    (t): t is { type: string; provinces: string[]; description: string } =>
      !!t && typeof t === 'object' && (t as { type?: string }).type === 'provinces',
  );
  if (tag && !tag.provinces.includes(province)) {
    tag.provinces.push(province);
    tag.description = tag.provinces.join(', ');
  }
}

/** Map Macro's payment.method code ("TC" credit / "TD" debit) → normalized keys. */
function paymentMethodsFromMacroMethod(method: string | null): string[] {
  if (!method) return [];
  const m = method.toUpperCase();
  const out: string[] = [];
  if (m.includes('TC')) out.push('CREDITO');
  if (m.includes('TD')) out.push('DEBITO');
  return out;
}
