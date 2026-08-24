/**
 * Regression tests for the Coto adapter's promotion parsing.
 *
 * These pin the fix for the client-reported bug "some Coto discounts are not
 * getting scraped": Coto's real `dtoDescuentos` payload uses `textoDescuento`
 * ("20%Dto") + `precioDescuento` ("$1520.00"), NOT the `porcentaje`/`monto`
 * fields the adapter used to look for — so discounts were silently dropped and
 * the export showed full price with no offer / no unit discount.
 *
 * The `attributes` blobs below are copied verbatim from the live
 * `?format=json` endpoint (Coto stores every attribute as a single-element
 * array of strings; the promo arrays are JSON-encoded strings inside that).
 */

import { describe, it, expect } from 'vitest';
import { parseCotoResponse } from './coto.js';
import { flattenPromotions } from '../worker/promotions.js';
import type { Logger } from '../shared/logger.js';

const log = {
  info: () => undefined,
  debug: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => log,
} as unknown as Logger;

const ctx = { externalId: 'test-sku', logger: log };

/** Wrap a bag of Coto attributes into the `?format=json` envelope shape. */
function cotoResponse(attributes: Record<string, unknown>) {
  return {
    contents: [
      {
        Main: [
          {
            record: { attributes },
            'json-ld': JSON.stringify({
              offers: { availability: 'https://schema.org/InStock', priceCurrency: 'ARS' },
            }),
          },
        ],
      },
    ],
  };
}

describe('parseCotoResponse — discounts (dtoDescuentos)', () => {
  // Real record: Seven Up Lima Limón 500cc — 20% off, list $1900 -> $1520.
  const discounted = cotoResponse({
    'product.displayName': ['Gaseosa SEVEN UP Lima Limón 500 Cc'],
    'product.eanPrincipal': ['7790895000000'],
    'sku.dtoPrice': [
      '{"id":"pl200_00018877","skuId":"sku00018877","precioLista":1900.0,"precio":3800.0,"precioSinImp":1570.25}',
    ],
    'product.dtoDescuentos': [
      '[{"id":"37206663","textoVigencia":" ","textoPrecioRegular":"Precio Contado: $1900","precioRegular":"","textoDescuento":"20%Dto","precioDescuento":"$1520.00","imagenDescuento":" ","comentarios":" No acumulable con otras promos"}]',
    ],
    'product.dtoDescuentosMediosPago': ['[]'],
  });

  it('extracts the percentage and the exact discounted price', () => {
    const res = parseCotoResponse(discounted, ctx);
    expect(res.price).toBe(1900);
    expect(res.promotions).toHaveLength(1);
    const p = res.promotions![0]!;
    expect(p.type).toBe('discount');
    expect(p.discountPct).toBe(20);
    expect(p.offerPrice).toBe(1520);
    expect(p.description).toContain('20%Dto');
    expect(p.description).toContain('No acumulable');
  });

  it('flattens into offer_price_1 + unit_discount for the client export', () => {
    const res = parseCotoResponse(discounted, ctx);
    const flat = flattenPromotions(res.promotions, res.price);
    // Precio_c_Oferta_1 = the exact published discounted price.
    expect(flat.offer_price_1).toBe(1520);
    // Descuento_Unitario = 20% as a fraction.
    expect(flat.unit_discount).toBe(0.2);
    expect(flat.promotion_1).toContain('20%Dto');
  });

  it('returns no promotions when dtoDescuentos is empty', () => {
    const res = parseCotoResponse(
      cotoResponse({
        'product.displayName': ['Lavandina Ayudín 2L'],
        'sku.dtoPrice': [
          '{"id":"pl200_00591050","skuId":"sku00591050","precioLista":2925.99,"precio":1463.0,"precioSinImp":2418.17}',
        ],
        'product.dtoDescuentos': ['[]'],
        'product.dtoDescuentosMediosPago': ['[]'],
      }),
      ctx,
    );
    expect(res.price).toBe(2925.99);
    expect(res.promotions).toEqual([]);
  });
});

describe('parseCotoResponse — financing (dtoDescuentosMediosPago)', () => {
  it('describes cuotas without inventing an offer price', () => {
    const res = parseCotoResponse(
      cotoResponse({
        'product.displayName': ['Grooming Kit PHILIPS'],
        'sku.dtoPrice': [
          '{"id":"pl200_x","skuId":"skux","precioLista":93499.0,"precio":93499.0}',
        ],
        'product.dtoDescuentos': ['[]'],
        'product.dtoDescuentosMediosPago': [
          '[{"id":"80372620","precioCuota":"$7791.58","cantidadCuotas":"12","imagenDescuento":"/x.png"}]',
        ],
      }),
      ctx,
    );
    expect(res.promotions).toHaveLength(1);
    const p = res.promotions![0]!;
    expect(p.type).toBe('payment_method');
    expect(p.description).toBe('12 cuotas de $7791.58');
    expect(p.offerPrice).toBeUndefined();
    expect(p.discountPct).toBeUndefined();

    // Financing must not populate the offer-price column.
    const flat = flattenPromotions(res.promotions, res.price);
    expect(flat.offer_price_1).toBeNull();
    expect(flat.unit_discount).toBeNull();
  });
});
