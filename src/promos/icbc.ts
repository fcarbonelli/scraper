/**
 * ICBC promotions provider.
 *
 * ICBC's benefits SPA (`beneficios.icbc.com.ar`, a Vite app) is backed by a
 * public JSON API (`prod-utilidades-icbc.pisol.net/api/web/v1`) whose calls
 * carry two headers the SPA injects: a public `apikey` and an `accesstoken`.
 * Rather than hardcode those (they rotate), we drive a real Chromium via the
 * shared {@link withPageFetcher}: load the SPA, capture both headers from the
 * app's own request (in-memory, never logged), then replay the paginated API
 * in-page (real Chrome TLS + correct Origin/CORS).
 *
 * The catalog is organized by **rubro** (category). There is no flat list, so we
 * enumerate rubros and paginate each:
 *   GET /beneficios/rubros                                   → [{ id, name, … }]
 *   GET /beneficios/get-total-records?heading_id=<id>        → { data: <count> }
 *   GET /beneficios/get?heading_id=<id>&offset=N&limit=M     → { data: [ … ] }
 *
 * All promos are attributed issuer='ICBC'.
 */

import {
  parseYmdDate,
  weekdaysFromDayCodes,
  normalizePaymentMethods,
} from './normalize.js';
import { withPageFetcher, type BrowserLaunchOptions } from './browserFetch.js';
import type {
  NormalizedPromotion,
  PromoContext,
  PromoProvider,
  PromotionPlan,
} from './types.js';

const DEFAULT_ORIGIN = 'https://beneficios.icbc.com.ar/';
const DEFAULT_BASE = 'https://prod-utilidades-icbc.pisol.net/api/web/v1';
/** Where a promo's `url_front` slug resolves (the public detail page). */
const FRONT_BASE = 'https://beneficios.icbc.com.ar/';

const API_HEADERS: Record<string, string> = {
  accept: 'application/json, text/plain, */*',
  'content-type': 'application/json',
};

const PAGE_LIMIT = 60; // items per /beneficios/get page
const MAX_PAGES_PER_RUBRO = 60; // safety cap (60 * 60 = 3600 promos/rubro)

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
/** Parse a numeric-ish field (ICBC ships numbers as strings), 0/blank → null. */
function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export const icbcProvider: PromoProvider = {
  id: 'icbc',
  name: 'ICBC',

  async fetchAll(ctx: PromoContext): Promise<NormalizedPromotion[]> {
    const origin = str(ctx.config['origin']) ?? DEFAULT_ORIGIN;
    const base = str(ctx.config['baseUrl']) ?? DEFAULT_BASE;
    const launch = (ctx.config['launch'] as BrowserLaunchOptions | undefined) ?? {};
    const log = ctx.logger.child({ provider: 'icbc' });

    return withPageFetcher(
      {
        origin,
        headers: API_HEADERS,
        // The SPA injects a public `apikey` + an `accesstoken` on every API call.
        captureHeaders: {
          urlIncludes: 'pisol.net',
          names: ['apikey', 'accesstoken'],
        },
        bootMs: 7000,
        logger: ctx.logger,
        launch,
        signal: ctx.signal,
      },
      async (f) => {
        // 1) Enumerate rubros (categories).
        const rubrosRes = await f.getJson(`${base}/beneficios/rubros`);
        const rubros = asArray(asRecord(rubrosRes.json)['data'])
          .map((r) => asRecord(r))
          .filter((r) => str(r['id']));
        if (rubros.length === 0) {
          log.warn({ status: rubrosRes.status }, 'icbc: no rubros returned');
          return [];
        }

        // 2) Paginate each rubro, de-duping by promo id (a promo has one rubro,
        //    but we guard anyway).
        const byId = new Map<string, NormalizedPromotion>();
        for (const rubro of rubros) {
          if (ctx.signal?.aborted) throw new Error('aborted');
          const headingId = str(rubro['id'])!;
          const rubroName = str(rubro['name']);
          const before = byId.size;

          for (let page = 0; page < MAX_PAGES_PER_RUBRO; page++) {
            const offset = page * PAGE_LIMIT;
            const url =
              `${base}/beneficios/get?limit=${PAGE_LIMIT}&orden=0` +
              `&offset=${offset}&heading_id=${encodeURIComponent(headingId)}`;
            const { status, json } = await f.getJson(url);
            if (status !== 200) break;
            const list = asArray(asRecord(json)['data']);
            if (list.length === 0) break;
            for (const item of list) {
              const promo = mapItem(item, rubroName);
              if (promo && !byId.has(promo.externalId)) byId.set(promo.externalId, promo);
            }
            if (list.length < PAGE_LIMIT) break; // last page
          }
          log.debug(
            { rubro: rubroName, added: byId.size - before, total: byId.size },
            'icbc: rubro done',
          );
        }

        log.info({ promotions: byId.size }, 'icbc: fetch complete');
        return [...byId.values()];
      },
    );
  },
};

/**
 * Map one ICBC promo onto a NormalizedPromotion. Item shape (numbers as strings):
 *   { id, title, store, heading_id, rubro, date_start, date_end,
 *     days:["LU",…], text_days, cards:["VISA","DEBITO"], system:["MODO"],
 *     legal, url_front, ahorro_maximo, cuotas_maximo, url_logo,
 *     segments:[{ ahorro, numero_cuotas, saving, segment, … }],
 *     campaigns:[{ name, … }] }
 * A promotion bundles one plan per segment (fallback: a single top-level plan).
 */
function mapItem(raw: unknown, rubroName: string | null): NormalizedPromotion | null {
  const p = asRecord(raw);
  const externalId = str(p['id']);
  if (!externalId) return null;

  const merchant = str(p['store']) ?? str(p['title']);
  if (!merchant) return null;

  const categoryName = str(p['rubro']) ?? rubroName;
  const validFrom = parseYmdDate(p['date_start']);
  const validTo = parseYmdDate(p['date_end']);
  const weekdays = weekdaysFromDayCodes(p['days']);
  const paymentMethods = paymentMethodsFromCards(p['cards']);

  const maxDiscountPct = clampPct(num(p['ahorro_maximo']));
  const maxInstallments = installmentsFrom(num(p['cuotas_maximo']));

  const logoUrl = str(p['url_logo']);
  const urlFront = str(p['url_front']);
  const fullUrl = urlFront ? `${FRONT_BASE}${urlFront.replace(/^\/+/, '')}` : null;

  // Headline: "<discount>% en <merchant>" when a discount exists, else merchant.
  const title = maxDiscountPct ? `${maxDiscountPct}% en ${merchant}` : merchant;

  const plans = buildPlans(p, { paymentMethods, weekdays, validFrom, validTo });

  const tags: unknown[] = [];
  for (const c of asArray(p['campaigns'])) {
    const name = str(asRecord(c)['name']);
    if (name) tags.push({ type: 'campaign', description: name });
  }
  for (const s of asArray(p['system'])) {
    const name = str(s);
    if (name) tags.push({ type: 'system', description: name });
  }
  const cap = capFromSegments(p['segments']);
  if (cap) tags.push({ type: 'cap', description: cap });

  return {
    providerId: 'icbc',
    externalId,
    title,
    issuer: 'ICBC',
    merchant,
    category: null,
    categoryName,
    subcategory: null,
    subtitle: str(p['text_days']),
    paymentMethods,
    weekdays,
    purchaseModes: [],
    maxDiscountPct,
    maxInstallments,
    validFrom,
    validTo,
    url: urlFront,
    fullUrl,
    logoUrl,
    imageUrl: logoUrl,
    isFeatured: false,
    plans,
    tags,
    raw: p,
  };
}

/**
 * Build one PromotionPlan per segment (each segment carries its own
 * ahorro/cuotas/cap). Falls back to a single plan derived from the top-level
 * fields when no segments are present.
 */
function buildPlans(
  p: Record<string, unknown>,
  base: {
    paymentMethods: string[];
    weekdays: string[];
    validFrom: string | null;
    validTo: string | null;
  },
): PromotionPlan[] {
  const segments = asArray(p['segments']).map((s) => asRecord(s));
  const merchant = str(p['store']) ?? str(p['title']) ?? '';

  if (segments.length === 0) {
    const discountPct = clampPct(num(p['ahorro_maximo']));
    return [
      {
        title: discountPct ? `${discountPct}% en ${merchant}` : merchant,
        paymentMethods: base.paymentMethods,
        weekdays: base.weekdays,
        validFrom: base.validFrom,
        validTo: base.validTo,
        appliesOnline: null,
        discountPct,
        installments: installmentsFrom(num(p['cuotas_maximo'])),
      },
    ];
  }

  return segments.map((s) => {
    const discountPct = clampPct(num(s['ahorro']) ?? num(s['descuento']));
    const installments = installmentsFrom(num(s['numero_cuotas']));
    const segName = str(s['segment']) ?? 'GENERAL';
    // Title: prefer a discount, else installments, else the segment name.
    const title = discountPct
      ? `${discountPct}% (${segName})`
      : installments
        ? `${installments} cuotas (${segName})`
        : segName;
    return {
      title,
      paymentMethods: base.paymentMethods,
      weekdays: base.weekdays,
      validFrom: base.validFrom,
      validTo: base.validTo,
      appliesOnline: null,
      discountPct,
      installments,
      raw: s,
    };
  });
}

/** Clamp a percentage into (0, 100]; anything else → null. */
function clampPct(n: number | null): number | null {
  return n != null && n > 0 && n <= 100 ? Math.round(n) : null;
}

/** Treat a positive installment count > 1 as meaningful; 0/1/blank → null. */
function installmentsFrom(n: number | null): number | null {
  return n != null && Number.isInteger(n) && n > 1 ? n : null;
}

/**
 * Map ICBC's `cards` list (["VISA","MASTER","DEBITO"]) onto normalized keys:
 * pass the networks through uppercased, and add the coarse CREDITO when a credit
 * network is present alongside/without an explicit DEBITO token.
 */
function paymentMethodsFromCards(cards: unknown): string[] {
  const out = new Set(normalizePaymentMethods(cards));
  if (out.has('VISA') || out.has('MASTER') || out.has('AMEX') || out.has('CABAL')) {
    // ICBC lists DEBITO explicitly; the bare networks imply credit.
    if (!out.has('DEBITO') || out.size > 1) out.add('CREDITO');
  }
  return [...out];
}

/** Human-readable reintegro cap from the richest segment (e.g. "$8000 MODO…"). */
function capFromSegments(segments: unknown): string | null {
  for (const s of asArray(segments)) {
    const seg = asRecord(s);
    const saving = num(seg['saving']);
    if (saving && saving > 0) {
      const type = str(seg['type_saving']);
      return type ? `$${saving} — ${type}` : `$${saving}`;
    }
  }
  return null;
}
