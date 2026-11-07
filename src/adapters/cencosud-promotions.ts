/**
 * Cencosud (Jumbo / Disco / Vea) promotions.
 *
 * Cencosud does NOT publish its promos through the standard VTEX catalog
 * (`commertialOffer.Price` stays at the regular price, `PromotionTeasers` is
 * empty, `ListPrice` is a sentinel). The storefront instead calls a custom
 * endpoint per SKU and paints the "-30%" badge client-side:
 *
 *   POST /_v/search-promotions   { seller, skus: [<skuId>] }
 *   -> { promotions: { generic|jumbo_prime|sgc: { promotions: { <sku>: {...} } } } }
 *
 * `seller` is the chain's default branch seller (hardcoded in the store theme
 * bundle). An unknown seller returns 200 with EMPTY buckets — not an error —
 * so a seller rename shows up as "no promos", never as a failed scrape.
 *
 * Mapping (mirrors Coto + the Carrefour "cash only" decision):
 *   - plain "N%" percentual, generic bucket  -> discount w/ offerPrice (Precio_c_Oferta_1)
 *   - fixed_price "Oferta" below the price   -> discount w/ offerPrice
 *   - multi-unit ("2do al 70%", "2x1", ...)  -> bundle, text only
 *   - card-restricted (providers) / weekday-restricted (days) / loyalty
 *     buckets (jumbo_prime, sgc)              -> text only
 * Every description carries the validity window ("vigente dd/mm al dd/mm").
 */

import type { Logger } from '../shared/logger.js';
import type { Promotion } from './types.js';

const REQUEST_TIMEOUT_MS = 10_000;

/** Above this the "discount" is almost certainly a data error, not a promo. */
const MAX_SANE_DISCOUNT = 0.9;

/** One promo entry as returned by /_v/search-promotions (only fields we read). */
export interface CencosudPromo {
  name?: string;
  type?: string;
  discountType?: string;
  code?: string;
  value?: number;
  effectiveDiscount?: string | number;
  start?: string;
  end?: string;
  days?: unknown;
  providers?: unknown[];
  [key: string]: unknown;
}

interface SearchPromotionsResponse {
  promotions?: Record<string, { promotions?: Record<string, CencosudPromo | CencosudPromo[]> }>;
}

/** A promo tagged with the bucket it came from ("generic", "jumbo_prime", "sgc"). */
export interface BucketedPromo {
  bucket: string;
  promo: CencosudPromo;
}

/**
 * Fetch every promo Cencosud exposes for one SKU. Returns [] when there are
 * none. Throws on transport/HTTP failure — the caller decides whether that's
 * fatal (it isn't: see `enrichWithCencosudPromotions`).
 */
export async function fetchCencosudPromotions(args: {
  baseUrl: string;
  seller: string;
  sku: string;
  userAgent: string;
  signal?: AbortSignal;
}): Promise<BucketedPromo[]> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onAbort = (): void => controller.abort();
  args.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(`${args.baseUrl}/_v/search-promotions`, {
      method: 'POST',
      headers: {
        'User-Agent': args.userAgent,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ seller: args.seller, skus: [args.sku] }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`search-promotions returned HTTP ${res.status}`);
    const body = (await res.json()) as SearchPromotionsResponse;

    const out: BucketedPromo[] = [];
    for (const [bucket, b] of Object.entries(body.promotions ?? {})) {
      const entry = b?.promotions?.[args.sku];
      if (!entry) continue;
      for (const promo of Array.isArray(entry) ? entry : [entry]) {
        if (promo && typeof promo === 'object') out.push({ bucket, promo });
      }
    }
    return out;
  } finally {
    clearTimeout(timeoutId);
    args.signal?.removeEventListener('abort', onAbort);
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** "2026-11-06T00:01:00-03:00" -> "06/11" (the string already carries AR local time). */
function ddmm(iso: string | undefined): string | undefined {
  const m = iso?.match(/^\d{4}-(\d{2})-(\d{2})/);
  return m ? `${m[2]}/${m[1]}` : undefined;
}

function validityText(p: CencosudPromo): string {
  const from = ddmm(p.start);
  const to = ddmm(p.end);
  if (from && to) return `vigente ${from} al ${to}`;
  if (to) return `vigente hasta ${to}`;
  return '';
}

function isActive(p: CencosudPromo, now: Date): boolean {
  const start = p.start ? Date.parse(p.start) : NaN;
  const end = p.end ? Date.parse(p.end) : NaN;
  if (Number.isFinite(start) && now.getTime() < start) return false;
  if (Number.isFinite(end) && now.getTime() > end) return false;
  return true;
}

function hasEntries(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === 'object') return Object.keys(v).length > 0;
  return false;
}

function fmtMoney(n: number): string {
  return `$${n.toLocaleString('es-AR', { maximumFractionDigits: 2 })}`;
}

/**
 * Pure: turn the SKU's Cencosud promos into our `Promotion[]` given the regular
 * shelf `price`. Priced (unconditional single-unit) promos come first so they
 * win `offer_price_1`; expired/not-yet-started ones are dropped.
 */
export function mapCencosudPromotions(
  promos: BucketedPromo[],
  price: number,
  now: Date = new Date(),
): Promotion[] {
  const priced: Promotion[] = [];
  const textOnly: Promotion[] = [];

  for (const { bucket, promo } of promos) {
    if (!isActive(promo, now)) continue;
    const code = (promo.code ?? '').trim();
    const validity = validityText(promo);
    const withValidity = (label: string): string => (validity ? `${label} — ${validity}` : label);
    const raw = { bucket, ...promo };

    const conditional = bucket !== 'generic' || hasEntries(promo.providers) || hasEntries(promo.days);
    if (conditional) {
      const type: Promotion['type'] = hasEntries(promo.providers)
        ? 'payment_method'
        : bucket !== 'generic'
          ? 'loyalty'
          : 'unknown';
      textOnly.push({ type, description: withValidity(code || promo.name || 'Promoción'), raw });
      continue;
    }

    const eff = Number(promo.effectiveDiscount);
    const effOk = Number.isFinite(eff) && eff > 0 && eff < MAX_SANE_DISCOUNT;

    // Plain "30%" off one unit: the shelf price the site shows is price × (1 − eff).
    if (promo.discountType === 'percentual' && /^\d+(?:[.,]\d+)?\s*%$/.test(code) && effOk && price > 0) {
      priced.push({
        type: 'discount',
        description: withValidity(code),
        discountPct: round2(eff * 100),
        offerPrice: round2(price * (1 - eff)),
        raw,
      });
      continue;
    }

    // "Oferta" at a fixed price: `value` IS the offer price.
    if (promo.discountType === 'fixed_price' && typeof promo.value === 'number') {
      const offer = promo.value;
      if (offer > 0 && price > 0 && offer < price && 1 - offer / price < MAX_SANE_DISCOUNT) {
        priced.push({
          type: 'discount',
          description: withValidity(`Oferta ${fmtMoney(offer)}`),
          discountPct: round2((1 - offer / price) * 100),
          offerPrice: round2(offer),
          raw,
        });
      }
      continue;
    }

    // Multi-unit ("2do al 70%", "2x1", ...) and anything unrecognized: text only.
    textOnly.push({
      type: /\d\s*x\s*\d|\d+\s*(?:do|da|ra|er)\b/i.test(code) ? 'bundle' : 'unknown',
      description: withValidity(code || promo.name || 'Promoción'),
      raw,
    });
  }

  return [...priced, ...textOnly];
}

/**
 * Best-effort enrichment: fetch + map the SKU's promos. A failure of the promo
 * endpoint must not lose the day's price, so it's logged (warn) and recorded in
 * `rawData` instead of thrown.
 */
export async function loadCencosudPromotions(args: {
  baseUrl: string;
  seller: string;
  sku: string;
  price: number;
  userAgent: string;
  signal?: AbortSignal;
  logger: Logger;
}): Promise<{ promotions: Promotion[]; raw: unknown }> {
  try {
    const found = await fetchCencosudPromotions(args);
    return { promotions: mapCencosudPromotions(found, args.price), raw: found };
  } catch (err) {
    args.logger.warn({ err, sku: args.sku }, 'Cencosud search-promotions failed; scraping without promos');
    return { promotions: [], raw: { error: err instanceof Error ? err.message : String(err) } };
  }
}
