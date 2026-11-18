/**
 * Promo parsing for chains whose promos were never captured (client report
 * Nov 2026): Cencosud's /_v/search-promotions mapping, Átomo's PrestaShop
 * flags, and La Reina's "SIN STOCK" marker. Payload shapes are copied from
 * live responses.
 */

import { describe, it, expect } from 'vitest';
import { mapCencosudPromotions, type BucketedPromo } from './cencosud-promotions.js';
import { extractAtomoPromotions } from './atomo.js';
import { parseLaReinaHtml } from './la-reina.js';
import { flattenPromotions } from '../worker/promotions.js';
import type { Logger } from '../shared/logger.js';

const NOW = new Date('2026-11-07T12:00:00-03:00');

function generic(promo: BucketedPromo['promo']): BucketedPromo {
  return { bucket: 'generic', promo };
}

const pct30: BucketedPromo = generic({
  name: '30% VANISH | Ofertas Trafico',
  type: 'regular',
  discountType: 'percentual',
  code: '30%',
  value: 0,
  effectiveDiscount: '0.30',
  start: '2026-11-06T00:01:00-03:00',
  end: '2026-11-08T23:59:00-03:00',
  days: {},
  providers: [],
});

describe('mapCencosudPromotions', () => {
  it('maps a plain N% promo to an offer price with validity', () => {
    const [p] = mapCencosudPromotions([pct30], 5700, NOW);
    expect(p).toMatchObject({ type: 'discount', discountPct: 30, offerPrice: 3990 });
    expect(p?.description).toBe('30% — vigente 06/11 al 08/11');
    expect(flattenPromotions([p!], 5700)).toMatchObject({ offer_price_1: 3990, unit_discount: 0.3 });
  });

  it('keeps multi-unit promos as text only', () => {
    const promos = mapCencosudPromotions(
      [generic({ ...pct30.promo, code: '2do al 70%', effectiveDiscount: '0.35' }), generic({ ...pct30.promo, code: '2x1', effectiveDiscount: '0.50' })],
      4550,
      NOW,
    );
    expect(promos.map((p) => p.type)).toEqual(['bundle', 'bundle']);
    expect(promos.every((p) => p.offerPrice === undefined && p.discountPct === undefined)).toBe(true);
    expect(flattenPromotions(promos, 4550)).toMatchObject({ offer_price_1: null, unit_discount: null });
  });

  it('uses the fixed-price value as the offer', () => {
    const [p] = mapCencosudPromotions(
      [generic({ ...pct30.promo, discountType: 'fixed_price', code: 'Oferta', value: 7499, effectiveDiscount: '0.36' })],
      11700,
      NOW,
    );
    expect(p).toMatchObject({ type: 'discount', offerPrice: 7499 });
  });

  it('drops a fixed-price "offer" that is not below the price', () => {
    const promos = mapCencosudPromotions(
      [generic({ ...pct30.promo, discountType: 'fixed_price', code: 'Oferta', value: 1850, effectiveDiscount: '0.00' })],
      1850,
      NOW,
    );
    expect(promos).toEqual([]);
  });

  it('keeps card / loyalty / weekday promos as text only', () => {
    const promos = mapCencosudPromotions(
      [
        generic({ ...pct30.promo, providers: ['galicia'] }),
        { bucket: 'jumbo_prime', promo: pct30.promo },
        generic({ ...pct30.promo, days: { monday: true } }),
      ],
      5700,
      NOW,
    );
    expect(promos.map((p) => p.type)).toEqual(['payment_method', 'loyalty', 'unknown']);
    expect(promos.every((p) => p.offerPrice === undefined)).toBe(true);
  });

  it('skips promos outside their validity window', () => {
    expect(mapCencosudPromotions([pct30], 5700, new Date('2026-11-09T10:00:00-03:00'))).toEqual([]);
  });

  it('puts priced promos before text-only ones', () => {
    const promos = mapCencosudPromotions(
      [generic({ ...pct30.promo, code: '2do al 70%' }), pct30],
      5700,
      NOW,
    );
    expect(promos[0]?.offerPrice).toBe(3990);
  });
});

describe('extractAtomoPromotions', () => {
  it('flags "En oferta" without a real reduction as text only', () => {
    const html =
      '<body id="product" class="page-product product-on-sale product-id-40035">' +
      '<div data-product="{&quot;price_without_reduction&quot;:3479.99988,&quot;has_discount&quot;:false}">';
    expect(extractAtomoPromotions(html, 3480)).toEqual({
      promotions: [{ type: 'unknown', description: 'En oferta' }],
    });
  });

  it('uses regular_price_amount as list price on a real discount', () => {
    const html =
      '<body class="page-product product-on-sale">' +
      '<div data-product="{&quot;has_discount&quot;:true,&quot;regular_price_amount&quot;:4000}">';
    const r = extractAtomoPromotions(html, 3000);
    expect(r.listPrice).toBe(4000);
    expect(r.promotions[0]).toMatchObject({ type: 'discount', offerPrice: 3000, discountPct: 25 });
  });

  it('returns nothing for a regular product', () => {
    expect(extractAtomoPromotions('<body class="page-product">', 1000)).toEqual({ promotions: [] });
  });
});

describe('parseLaReinaHtml stock', () => {
  const log = { debug: () => undefined } as unknown as Logger;
  const page = (extra: string): string =>
    `<h1 class='seo-title'>Lavandina</h1><div class='TotPreTik'>$4.006,<b>00</b></div>${extra}`;
  const ctx = { externalId: '7798125150139', externalUrl: 'https://www.lareinaonline.com.ar/productosdet.asp?Pr=7798125150139', logger: log };

  it('marks "SIN STOCK" pages out of stock but keeps the price', () => {
    const r = parseLaReinaHtml(
      page('<div style="display:inline-block; color: red; font-size: medium;">SIN STOCK</div>'),
      ctx,
    );
    expect(r).toMatchObject({ inStock: false, price: 4006 });
  });

  it('keeps regular pages in stock', () => {
    expect(parseLaReinaHtml(page(''), ctx).inStock).toBe(true);
  });
});
