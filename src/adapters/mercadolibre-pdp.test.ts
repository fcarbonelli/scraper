import { describe, expect, it } from 'vitest';
import { isMlBlockPage, parseMlPdp } from './mercadolibre-pdp.js';

/** Minimal PDP built from the real 2026-11-24 markup (Trenet, Ecomodico pin). */
function pdp(opts: {
  price: number;
  original?: number | null;
  sellerId?: number;
  itemId?: string;
  availability?: string;
  otherSellerPricing?: string;
}): string {
  const ld = {
    name: 'Trenet Quitamanchas para Ropa Power Precision En Polvo Prelavado 450 G',
    image: 'https:\u002F\u002Fhttp2.mlstatic.com\u002FD_NQ_NP_801537-MLA95233507905_102025-O.webp',
    offers: {
      price: opts.price,
      availability: opts.availability ?? 'https://schema.org/InStock',
      '@type': 'Offer',
      priceCurrency: 'ARS',
    },
    '@type': 'Product',
  };
  const original = opts.original === undefined ? null : opts.original;
  return [
    '<html><head>',
    `<script type="application/ld+json">${JSON.stringify(ld)}</script>`,
    '<script type="application/ld+json">{"@type":"BreadcrumbList","itemListElement":[]}</script>',
    '</head><body>',
    `<script>{"track":{"item_info":{"domain_id":"MLA-STAIN_REMOVERS","category_id":"MLA407836",` +
      `"item_id":"${opts.itemId ?? 'MLA2546019306'}","catalog_product_id":"MLA60125032",` +
      `"seller_id":${opts.sellerId ?? 179907718},"user_product_id":"MLAU3488892015"}}}</script>`,
    opts.otherSellerPricing ?? '',
    `<script>{"price":${opts.price},"original_price":${original},"currency_id":"ARS","available_promotions":[]}</script>`,
    '</body></html>',
  ].join('');
}

describe('parseMlPdp', () => {
  it('reads price, struck price, seller and item of the pinned offer', () => {
    const o = parseMlPdp(pdp({ price: 10378, original: 11532 }));
    expect(o).toMatchObject({
      itemId: 'MLA2546019306',
      catalogId: 'MLA60125032',
      sellerId: 179907718,
      price: 10378,
      originalPrice: 11532,
      currency: 'ARS',
      inStock: true,
    });
    expect(o?.name).toContain('Trenet');
    expect(o?.imageUrl).toContain('mlstatic.com');
  });

  it('has no originalPrice when the listing is not on sale', () => {
    const o = parseMlPdp(pdp({ price: 5572, original: null }));
    expect(o?.price).toBe(5572);
    expect(o?.originalPrice).toBeUndefined();
  });

  it('ignores another seller\u2019s pricing blob on the same page', () => {
    const other = '<script>{"price":9999,"original_price":20000,"currency_id":"ARS"}</script>';
    const o = parseMlPdp(pdp({ price: 5220, original: null, otherSellerPricing: other }));
    expect(o?.originalPrice).toBeUndefined();
  });

  it('reports the displayed seller when the pin was ignored', () => {
    const o = parseMlPdp(pdp({ price: 10460.98, sellerId: 3267790336, itemId: 'MLA1111111111' }));
    expect(o?.sellerId).toBe(3267790336);
    expect(o?.itemId).toBe('MLA1111111111');
  });

  it('marks out-of-stock offers', () => {
    expect(parseMlPdp(pdp({ price: 100, availability: 'https://schema.org/OutOfStock' }))?.inStock).toBe(false);
  });

  it('returns null without a priced JSON-LD offer', () => {
    expect(parseMlPdp('<html><title>Trenet</title><p>Continuar</p></html>')).toBeNull();
  });
});

describe('isMlBlockPage', () => {
  it('detects the login wall and the error page', () => {
    expect(isMlBlockPage('', 'https://www.mercadolibre.com.ar/gz/account-verification?go=x')).toBe(true);
    expect(isMlBlockPage('<p>Hubo un error accediendo a esta pagina...</p>', 'https://www.mercadolibre.com.ar/p/MLA1')).toBe(true);
    expect(isMlBlockPage(pdp({ price: 1 }), 'https://www.mercadolibre.com.ar/x/p/MLA60125032')).toBe(false);
  });
});
