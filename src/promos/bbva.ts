/**
 * BBVA (Go / "willgo") promotions provider.
 *
 * BBVA's benefits catalog (bbva.com.ar/beneficios, a Next.js SPA) is backed by
 * the public **Go** JSON API — no auth, browser headers only. Base:
 *
 *   https://go.bbva.com.ar/willgo/fgo/API
 *     GET /v3/communications?pager=N          → the paged benefits list (20/page)
 *     GET /v3/communication/{id}              → one benefit (bases, channels…)
 *     GET /v3/rubros/filtro?filtro_padre=true → category taxonomy
 *
 * The list carries enough for a card (title, dates, cap, card group, image);
 * we enumerate every page and normalize. Detail is available but not needed for
 * the dashboard, so we skip the ~900 extra calls.
 */

import {
  parseDiscountPct,
  parseInstallments,
  parseYmdDate,
} from './normalize.js';
import type {
  NormalizedPromotion,
  PromoContext,
  PromoProvider,
  PromotionPlan,
} from './types.js';

const DEFAULT_BASE_URL = 'https://go.bbva.com.ar/willgo/fgo/API';

/** Realistic browser headers (the Go API is public but expects them). */
const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
  Origin: 'https://www.bbva.com.ar',
  Referer: 'https://www.bbva.com.ar/',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'es-AR,es;q=0.9',
};

const MAX_PAGES = 200; // safety cap (catalog is ~46 pages today)

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

export const bbvaProvider: PromoProvider = {
  id: 'bbva',
  name: 'BBVA',

  async fetchAll(ctx: PromoContext): Promise<NormalizedPromotion[]> {
    const baseUrl = str(ctx.config['baseUrl']) ?? DEFAULT_BASE_URL;
    const maxPagesCfg = Number(ctx.config['maxPages']);
    const pageCap =
      Number.isInteger(maxPagesCfg) && maxPagesCfg > 0 ? maxPagesCfg : MAX_PAGES;
    const log = ctx.logger.child({ provider: 'bbva' });

    const byId = new Map<string, NormalizedPromotion>();
    for (let pager = 0; pager < pageCap; pager++) {
      if (ctx.signal?.aborted) throw new Error('aborted');
      const res = await getJson(
        `${baseUrl}/v3/communications?pager=${pager}`,
        ctx.signal,
      );
      const items = asArray(res['data']);
      if (items.length === 0) break; // past the last page
      for (const item of items) {
        const promo = mapItem(item);
        if (promo) byId.set(promo.externalId, promo);
      }
      if (pager === 0) log.info({ message: res['message'] }, 'bbva: paging benefits');
    }

    log.info({ promotions: byId.size }, 'bbva: fetch complete');
    return [...byId.values()];
  },
};

/** Map one BBVA Go "communication" onto a NormalizedPromotion. */
function mapItem(raw: unknown): NormalizedPromotion | null {
  const b = asRecord(raw);
  const externalId = str(b['id']);
  const title = str(b['cabecera']);
  if (!externalId || !title) return null;

  const subtitle = cleanText(str(b['subcabecera']));
  const validFrom = parseYmdDate(b['fechaDesde']);
  const validTo = parseYmdDate(b['fechaHasta']);
  const paymentMethods = paymentMethodsFromCardGroup(str(b['grupoTarjeta']));
  const textBlob = `${title} ${subtitle ?? ''}`;
  const discountPct = parseDiscountPct(textBlob);
  const installments = parseInstallments(textBlob);
  const isModo = b['esModo'] === true;

  const plan: PromotionPlan = {
    title,
    paymentMethods,
    weekdays: [],
    validFrom,
    validTo,
    appliesOnline: null,
    discountPct,
    installments,
  };

  return {
    providerId: 'bbva',
    externalId,
    title,
    issuer: 'BBVA',
    merchant: null,
    category: null,
    categoryName: null,
    subcategory: null,
    subtitle,
    paymentMethods,
    weekdays: [],
    purchaseModes: [],
    maxDiscountPct: discountPct,
    maxInstallments: installments,
    validFrom,
    validTo,
    url: null,
    fullUrl: null,
    logoUrl: null,
    imageUrl: str(b['imagen']),
    isFeatured: false,
    plans: [plan],
    // Keep the tope (spend cap) + MODO flag as lightweight tags for the UI.
    tags: buildTags(b, isModo),
    raw: b,
  };
}

/**
 * Map BBVA's "grupoTarjeta" label (e.g. "Tarjetas de crédito y débito BBVA")
 * onto normalized payment-method keys.
 */
function paymentMethodsFromCardGroup(group: string | null): string[] {
  if (!group) return [];
  const lower = group.toLowerCase();
  const out = new Set<string>();
  if (lower.includes('crédito') || lower.includes('credito')) out.add('CREDITO');
  if (lower.includes('débito') || lower.includes('debito')) out.add('DEBITO');
  if (lower.includes('visa')) out.add('VISA');
  if (lower.includes('master')) out.add('MASTER');
  if (lower.includes('amex') || lower.includes('american')) out.add('AMEX');
  return [...out];
}

/** Lightweight tags for the card: spend cap + MODO flag. */
function buildTags(b: Record<string, unknown>, isModo: boolean): unknown[] {
  const tags: unknown[] = [];
  const tope = str(b['montoTope']);
  if (tope) tags.push({ type: 'cap', description: `Tope $${tope}` });
  if (isModo) tags.push({ type: 'channel', description: 'MODO QR' });
  return tags;
}

/** Strip the boilerplate leading dots BBVA prefixes onto subcabecera. */
function cleanText(s: string | null): string | null {
  if (!s) return s;
  const cleaned = s.replace(/^[.\s]+/, '').trim();
  return cleaned.length > 0 ? cleaned : null;
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
