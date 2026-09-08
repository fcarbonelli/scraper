/**
 * Banco Galicia promotions provider.
 *
 * Galicia's benefits SPA (`beneficios.galicia.ar`, its "Quiero!" catalog) is
 * backed by a **public** JSON BFF at `loyalty.bff.bancogalicia.com.ar` — no
 * auth token, just an `accept: application/vnd.iman.v1+json` header plus the
 * `id_canal`/`id_channel` channel markers. BUT the BFF sits behind an **F5
 * BIG-IP WAF that fingerprints the TLS handshake (JA3)**, so plain `fetch`
 * (Node/undici/curl) is rejected with a "petición denegada" page.
 *
 * We get around it with the shared {@link withPageFetcher} helper: drive a real
 * Chromium, land on `beneficios.galicia.ar`, and run the API calls *inside the
 * page* (real Chrome JA3 + correct CORS origin). The flat catalog endpoint
 * returns every public promo, paginated:
 *
 *   GET /api/portal/personalizacion/v1/promociones/catalogo?page=N&pageSize=M
 *     → { data: { list: [ …promo… ], totalSize } }
 *   GET /api/portal/personalizacion/v1/categorias?…      → id → descripción
 *
 * All promos are attributed issuer='Galicia'.
 */

import {
  parseDiscountPct,
  parseInstallments,
  parseYmdDate,
  paymentMethodsFromMediosDePago,
  weekdaysFromLeyenda,
} from './normalize.js';
import { withPageFetcher, type BrowserLaunchOptions } from './browserFetch.js';
import type { Logger } from '../shared/logger.js';
import type {
  NormalizedPromotion,
  PromoContext,
  PromoProvider,
  PromotionPlan,
} from './types.js';

const DEFAULT_ORIGIN = 'https://beneficios.galicia.ar/';
const DEFAULT_BASE =
  'https://loyalty.bff.bancogalicia.com.ar/api/portal';

/** Headers the live SPA sends — the WAF/BFF expects the vendor Accept + channel. */
const API_HEADERS: Record<string, string> = {
  accept: 'application/vnd.iman.v1+json, application/json, text/plain, */*',
  id_canal: 'Quiero',
  id_channel: 'onlinebanking',
};

const PAGE_SIZE = 100;
const MAX_PAGES = 200; // safety cap

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

export const galiciaProvider: PromoProvider = {
  id: 'galicia',
  name: 'Banco Galicia',

  async fetchAll(ctx: PromoContext): Promise<NormalizedPromotion[]> {
    const origin = str(ctx.config['origin']) ?? DEFAULT_ORIGIN;
    const base = str(ctx.config['baseUrl']) ?? DEFAULT_BASE;
    const maxPagesCfg = Number(ctx.config['maxPages']);
    const pageCap =
      Number.isInteger(maxPagesCfg) && maxPagesCfg > 0 ? maxPagesCfg : MAX_PAGES;
    const launch = (ctx.config['launch'] as BrowserLaunchOptions | undefined) ?? {};
    const log = ctx.logger.child({ provider: 'galicia' });

    return withPageFetcher(
      { origin, headers: API_HEADERS, logger: ctx.logger, launch, signal: ctx.signal },
      async (f) => {
        // 1. Category taxonomy (id → name) to resolve each promo's category.
        const categoryById = await loadCategories(f, base, log);

        // 2. Paginate the flat public catalog.
        const byId = new Map<string, NormalizedPromotion>();
        for (let page = 1; page <= pageCap; page++) {
          if (ctx.signal?.aborted) throw new Error('aborted');
          const url = `${base}/personalizacion/v1/promociones/catalogo?page=${page}&pageSize=${PAGE_SIZE}`;
          const { status, json, raw } = await f.getJson(url);
          if (status !== 200) {
            if (page === 1) {
              throw new Error(
                `Galicia catalog page 1 failed: HTTP ${status} ${raw ?? ''}`,
              );
            }
            break; // transient tail failure — stop cleanly
          }
          const data = asRecord(asRecord(json)['data']);
          const list = asArray(data['list']);
          const total = Number(data['totalSize']);
          if (page === 1) log.info({ totalSize: total }, 'galicia: paging catalog');
          if (list.length === 0) break;
          for (const item of list) {
            const promo = mapItem(item, categoryById);
            if (promo) byId.set(promo.externalId, promo);
          }
          if (Number.isFinite(total) && page * PAGE_SIZE >= total) break;
        }

        log.info({ promotions: byId.size }, 'galicia: fetch complete');
        return [...byId.values()];
      },
    );
  },
};

/** Load the category taxonomy (id → descripción). Best-effort (empty on failure). */
async function loadCategories(
  f: { getJson: (u: string) => Promise<{ status: number; json: unknown }> },
  base: string,
  log: Logger,
): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  const url = `${base}/personalizacion/v1/categorias?idAudiencia=1&SubCategoria=false&Visibles=true`;
  const { status, json } = await f.getJson(url);
  if (status !== 200) {
    log.warn({ status }, 'galicia: categories fetch failed (continuing without names)');
    return map;
  }
  for (const raw of asArray(asRecord(asRecord(json)['data'])['list'])) {
    const c = asRecord(raw);
    const id = Number(c['id']);
    const name = str(c['descripcion']);
    if (Number.isFinite(id) && name) map.set(id, name);
  }
  return map;
}

/** Map one Galicia catalog item onto a NormalizedPromotion. */
function mapItem(
  raw: unknown,
  categoryById: Map<number, string>,
): NormalizedPromotion | null {
  const p = asRecord(raw);
  const externalId = str(p['id']);
  // `promocion` is the benefit line ("30% de descuento"); `titulo` the merchant.
  const benefit = str(p['promocion']);
  const merchant = str(p['titulo']);
  const title = benefit ?? merchant;
  if (!externalId || !title) return null;

  const categoryName = str(p['subtitulo']); // e.g. "Entretenimiento"
  const validTo = parseYmdDate(p['fechaHasta']);
  const paymentMethods = paymentMethodsFromMediosDePago(p['mediosDePago']);
  const weekdays = weekdaysFromLeyenda(p['leyendaDiasAplicacion']);
  const discountPct = parseDiscountPct(benefit);
  const installments = parseInstallments(benefit);
  const purchaseModes = purchaseModesFromFlags(p);

  const plan: PromotionPlan = {
    title,
    paymentMethods,
    weekdays,
    validFrom: null,
    validTo,
    appliesOnline: purchaseModes.includes('ONLINE') ? true : null,
    discountPct,
    installments,
  };

  return {
    providerId: 'galicia',
    externalId,
    title,
    issuer: 'Banco Galicia',
    merchant,
    category: null,
    categoryName,
    subcategory: null,
    subtitle: merchant, // the merchant reads well as a card subtitle
    paymentMethods,
    weekdays,
    purchaseModes,
    maxDiscountPct: discountPct,
    maxInstallments: installments,
    validFrom: null,
    validTo,
    url: null,
    fullUrl: str(p['link']),
    logoUrl: null,
    imageUrl: str(p['imagen']),
    isFeatured: p['eminent'] === true || p['onTop'] === true,
    plans: [plan],
    tags: buildTags(p),
    raw: p,
  };
}

/** Derive purchase modes from Galicia's channel flags (QR/NFC/contactless = in-store). */
function purchaseModesFromFlags(p: Record<string, unknown>): string[] {
  const out = new Set<string>();
  if (p['pagoQR'] === true || p['pagoNFC'] === true || p['contactLess'] === true) {
    out.add('IN_STORE');
  }
  return [...out];
}

/** Lightweight card tags: promo type + payment channels. */
function buildTags(p: Record<string, unknown>): unknown[] {
  const tags: unknown[] = [];
  const tipo = str(p['tipoPromocion']);
  if (tipo) tags.push({ type: 'kind', description: tipo });
  if (p['pagoQR'] === true) tags.push({ type: 'channel', description: 'Pago QR' });
  if (p['pagoNFC'] === true) tags.push({ type: 'channel', description: 'Pago NFC' });
  if (p['flagNovedad'] === true) tags.push({ type: 'flag', description: 'Novedad' });
  return tags;
}
