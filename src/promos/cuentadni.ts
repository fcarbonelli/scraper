/**
 * Cuenta DNI (Banco Provincia) promotions provider.
 *
 * Cuenta DNI is Banco Provincia's wallet. Its benefits page
 * (bancoprovincia.com.ar/cuentadni/contenidos/cdniBeneficios) is a CMS-rendered
 * grid, but it's backed by a plain ASP.NET JSON API (no WAF, no auth — a normal
 * `fetch` works with browser headers + `X-Requested-With: XMLHttpRequest`):
 *
 *   GET /cuentadni/Home/GetBeneficioByRubro?idRubro=<id>   → benefits for a rubro
 *   GET /cuentadni/Home/GetBeneficioData2?idBeneficio=<id> → one benefit (detail)
 *
 * There is no "all rubros" call (idRubro=0 → []), and the rubro-id set is sparse
 * (1, 2, 27, 32, 34 today). We discover the **active** rubro ids straight from
 * the benefits page HTML, which server-renders the category filter as
 * `filtrarPorRubro(<id>)`. Then we fetch each rubro and keep only **current**
 * benefits (not hidden, not expired) — the raw feed also carries stale/test rows.
 *
 * These are category-level wallet promos (e.g. "20% en comercios de cercanía"),
 * not per-merchant offers, so `merchant` is left null and weekdays are parsed
 * from the Spanish subtitle. All promos are attributed issuer='Cuenta DNI'.
 */

import { parseMsDate, weekdaysFromLeyenda } from './normalize.js';
import type {
  NormalizedPromotion,
  PromoContext,
  PromoProvider,
  PromotionPlan,
} from './types.js';

const DEFAULT_ORIGIN = 'https://www.bancoprovincia.com.ar';
const BENEFITS_PAGE = '/cuentadni/contenidos/cdniBeneficios/';
const RUBRO_ENDPOINT = '/cuentadni/Home/GetBeneficioByRubro?idRubro=';
/** Where a benefit's logo name resolves (the CMS image proxy). */
const CDN_GET = '/CDN/Get/';

const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
  Accept: 'application/json, text/javascript, */*; q=0.01',
  'Accept-Language': 'es-AR,es;q=0.9',
  'X-Requested-With': 'XMLHttpRequest',
};

/** Fallback rubro ids if the page scrape yields none (defensive only). */
const FALLBACK_RUBROS = [1, 2, 27, 32, 34];
/** Grace window: keep promos that expired at most this long ago (clock skew). */
const EXPIRY_GRACE_MS = 24 * 60 * 60 * 1000;

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}
function str(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : v == null ? '' : String(v);
  return s.length > 0 ? s : null;
}

export const cuentadniProvider: PromoProvider = {
  id: 'cuentadni',
  name: 'Cuenta DNI',

  async fetchAll(ctx: PromoContext): Promise<NormalizedPromotion[]> {
    const origin = str(ctx.config['origin']) ?? DEFAULT_ORIGIN;
    const log = ctx.logger.child({ provider: 'cuentadni' });

    // 1) Discover active rubro ids from the benefits page (server-rendered).
    const rubroIds = await discoverRubros(origin, ctx.signal, log);
    log.info({ rubroIds }, 'cuentadni: active rubros');

    // 2) Fetch each rubro, keep only current benefits, de-dupe by benefit id.
    const now = Date.now();
    const byId = new Map<string, NormalizedPromotion>();
    for (const rubroId of rubroIds) {
      if (ctx.signal?.aborted) throw new Error('aborted');
      const list = await getJson(`${origin}${RUBRO_ENDPOINT}${rubroId}`, ctx.signal);
      const items = asArray(list);
      let kept = 0;
      for (const item of items) {
        const b = asRecord(item);
        if (!isCurrent(b, now)) continue;
        const promo = mapItem(b, origin);
        if (promo && !byId.has(promo.externalId)) {
          byId.set(promo.externalId, promo);
          kept++;
        }
      }
      log.debug({ rubroId, total: items.length, kept }, 'cuentadni: rubro done');
    }

    log.info({ promotions: byId.size }, 'cuentadni: fetch complete');
    return [...byId.values()];
  },
};

/**
 * Discover active rubro ids by scraping the benefits page's category filter
 * (`filtrarPorRubro(<id>)`), dropping 0 ("Todos"). Falls back to the known set
 * if the page can't be read.
 */
async function discoverRubros(
  origin: string,
  signal: AbortSignal | undefined,
  log: PromoContext['logger'],
): Promise<number[]> {
  try {
    const res = await fetch(`${origin}${BENEFITS_PAGE}`, {
      headers: { 'User-Agent': BROWSER_HEADERS['User-Agent']!, Accept: 'text/html' },
      signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const ids = new Set<number>();
    for (const m of html.matchAll(/filtrarPorRubro\((\d+)\)/g)) {
      const id = Number(m[1]);
      if (Number.isInteger(id) && id > 0) ids.add(id);
    }
    if (ids.size > 0) return [...ids];
    log.warn('cuentadni: no rubros parsed from page, using fallback');
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'cuentadni: rubro discovery failed, using fallback');
  }
  return [...FALLBACK_RUBROS];
}

/**
 * A benefit is "current" when it isn't hidden (`oculto`) and hasn't expired
 * (`fecha_hasta` in the past, beyond a small grace window). Benefits with no end
 * date are treated as open-ended.
 */
function isCurrent(b: Record<string, unknown>, now: number): boolean {
  if (b['oculto'] === true) return false;
  const hasta = parseMsDate(b['fecha_hasta']);
  if (hasta == null) return true;
  return Date.parse(hasta) >= now - EXPIRY_GRACE_MS;
}

/**
 * Map one Cuenta DNI benefit onto a NormalizedPromotion. Item shape:
 *   { id, titulo, subtitulo, porcentaje, logo, bajada, legal, fecha_desde,
 *     fecha_hasta, url, titulo_fecha, orden, boton_pdf, oculto, tipo, urlPagina }
 * `tipo`: 1 = discount promo, 2 = installment financing ("Tarjeteá").
 */
function mapItem(b: Record<string, unknown>, origin: string): NormalizedPromotion | null {
  const externalId = str(b['id']);
  const title = str(b['titulo']);
  if (!externalId || !title) return null;

  const subtitle = str(b['subtitulo']) ?? str(b['bajada']);
  const pctNum = Number(b['porcentaje']);
  const discountPct =
    Number.isFinite(pctNum) && pctNum > 0 && pctNum <= 100 ? Math.round(pctNum) : null;
  const validFrom = parseMsDate(b['fecha_desde']);
  const validTo = parseMsDate(b['fecha_hasta']);
  // Weekdays live in the Spanish subtitle ("Los lunes", "sábados y domingos"…).
  const weekdays = weekdaysFromLeyenda(subtitle);

  const isFinancing = Number(b['tipo']) === 2;
  // Cuenta DNI is a wallet: promos are paid with the app (money/QR débito);
  // "Tarjeteá" (tipo 2) is card installments.
  const paymentMethods = isFinancing ? ['CREDITO', 'DINERO'] : ['DINERO'];

  const logoName = str(b['logo']);
  const logoUrl = logoName ? `${origin}${CDN_GET}${encodeURIComponent(logoName)}` : null;

  const plan: PromotionPlan = {
    title,
    paymentMethods,
    weekdays,
    validFrom,
    validTo,
    appliesOnline: null,
    discountPct,
    installments: null,
  };

  const tags: unknown[] = [];
  const legal = str(b['legal']);
  if (legal) tags.push({ type: 'terms', description: legal });
  if (isFinancing) tags.push({ type: 'channel', description: 'Cuotas' });
  const pdf = str(b['boton_pdf']);
  if (pdf) tags.push({ type: 'pdf', description: pdf });

  return {
    providerId: 'cuentadni',
    externalId,
    title,
    issuer: 'Cuenta DNI',
    merchant: null, // category-level wallet promos, not per-merchant
    category: null,
    categoryName: null,
    subcategory: null,
    subtitle,
    paymentMethods,
    weekdays,
    purchaseModes: [],
    maxDiscountPct: discountPct,
    maxInstallments: null,
    validFrom,
    validTo,
    url: str(b['urlPagina']) ?? str(b['url']),
    fullUrl: null,
    logoUrl,
    imageUrl: logoUrl,
    isFeatured: false,
    plans: [plan],
    tags,
    raw: b,
  };
}

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { method: 'GET', headers: BROWSER_HEADERS, signal });
  if (!res.ok) {
    throw new Error(`GET ${url} → HTTP ${res.status}`);
  }
  return res.json();
}
