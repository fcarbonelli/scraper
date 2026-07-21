/**
 * Unit tests for pure revista pricing / dedup helpers (no DB).
 */

import { describe, it, expect } from 'vitest';
import {
  mapSnapshotPrices,
  effectivePrices,
  decideTodayWrite,
  pickWinnerAmongDuplicates,
  losersAmongDuplicates,
  findEanCollisions,
  isRevistaSnapshotSource,
  buenosAiresDate,
  lastBaDays,
} from './pricing.js';

describe('mapSnapshotPrices', () => {
  it('uses regular price when there is no promo', () => {
    expect(mapSnapshotPrices({ price: 1299, promoPrice: null, promoText: null })).toEqual({
      price: 1299,
      list_price: null,
      promotion_1: null,
      offer_price_1: null,
      promotions: [],
    });
  });

  it('puts promo as selling price and regular as list_price on a markdown', () => {
    const mapped = mapSnapshotPrices({
      price: 1299,
      promoPrice: 999,
      promoText: 'OFERTA',
    });
    expect(mapped.price).toBe(999);
    expect(mapped.list_price).toBe(1299);
    expect(mapped.offer_price_1).toBe(999);
    expect(mapped.promotion_1).toBe('OFERTA');
    expect(mapped.promotions).toEqual([{ type: 'unknown', description: 'OFERTA' }]);
  });

  it('falls back to promo_price when regular is missing', () => {
    expect(mapSnapshotPrices({ price: null, promoPrice: 500, promoText: '2x1' }).price).toBe(500);
  });

  it('throws when neither price nor promo is present', () => {
    expect(() => mapSnapshotPrices({ price: null, promoPrice: null, promoText: null })).toThrow(
      /without a price/,
    );
  });

  it('treats empty promo text as absent', () => {
    const mapped = mapSnapshotPrices({ price: 100, promoPrice: null, promoText: '  ' });
    expect(mapped.promotion_1).toBeNull();
    expect(mapped.promotions).toEqual([]);
  });
});

describe('effectivePrices', () => {
  it('lets override win over extracted without mutating extracted', () => {
    const extracted = { price: 1000, promoPrice: null, promoText: null };
    const effective = effectivePrices(extracted, { price: 900, promoText: 'OFERTA' });
    expect(effective).toEqual({ price: 900, promoPrice: null, promoText: 'OFERTA' });
    expect(extracted.price).toBe(1000);
  });

  it('allows clearing promo via null override', () => {
    const effective = effectivePrices(
      { price: 1000, promoPrice: 800, promoText: 'OFERTA' },
      { promoPrice: null, promoText: null },
    );
    expect(effective.promoPrice).toBeNull();
    expect(effective.promoText).toBeNull();
  });
});

describe('decideTodayWrite', () => {
  it('inserts when there is no snapshot for today', () => {
    expect(decideTodayWrite(null)).toBe('insert');
    expect(decideTodayWrite(undefined)).toBe('insert');
  });

  it('updates in-place when today already has a snapshot', () => {
    expect(decideTodayWrite(42)).toBe('update');
  });
});

describe('pickWinnerAmongDuplicates / losersAmongDuplicates', () => {
  it('prefers the row with OFERTA when prices match', () => {
    const rows = [
      {
        id: 1,
        price: 1129,
        promotion_1: null,
        offer_price_1: null,
        scraped_at: '2026-07-20T10:00:00.000Z',
      },
      {
        id: 2,
        price: 1129,
        promotion_1: 'OFERTA',
        offer_price_1: null,
        scraped_at: '2026-07-20T09:00:00.000Z',
      },
    ];
    expect(pickWinnerAmongDuplicates(rows)?.id).toBe(2);
    expect(losersAmongDuplicates(rows).map((r) => r.id)).toEqual([1]);
  });

  it('on offer tie, picks the most recent scraped_at', () => {
    const rows = [
      {
        id: 'a',
        price: 100,
        promotion_1: 'OFERTA',
        offer_price_1: 90,
        scraped_at: '2026-07-20T08:00:00.000Z',
      },
      {
        id: 'b',
        price: 100,
        promotion_1: 'OFERTA',
        offer_price_1: 90,
        scraped_at: '2026-07-20T12:00:00.000Z',
      },
    ];
    expect(pickWinnerAmongDuplicates(rows)?.id).toBe('b');
  });

  it('without offers, picks the most recent', () => {
    const rows = [
      {
        id: 10,
        price: 1249,
        promotion_1: null,
        offer_price_1: null,
        scraped_at: '2026-07-20T08:00:00.000Z',
      },
      {
        id: 11,
        price: 2649,
        promotion_1: null,
        offer_price_1: null,
        scraped_at: '2026-07-20T09:00:00.000Z',
      },
    ];
    expect(pickWinnerAmongDuplicates(rows)?.id).toBe(11);
  });

  it('returns null for an empty list', () => {
    expect(pickWinnerAmongDuplicates([])).toBeNull();
    expect(losersAmongDuplicates([])).toEqual([]);
  });
});

describe('findEanCollisions', () => {
  it('flags same EAN + chain + day with distinct product_ids (Flexi vs Cierra fácil)', () => {
    const collisions = findEanCollisions([
      {
        ean: '7790117061850',
        supermarket_id: 'rosental',
        day: '2026-07-20',
        product_id: 'prod-flexi',
        name: 'Flexi, cierre',
      },
      {
        ean: '7790117061850',
        supermarket_id: 'rosental',
        day: '2026-07-20',
        product_id: 'prod-cierra',
        name: 'Cierra fácil',
      },
    ]);
    expect(collisions).toHaveLength(1);
    expect(collisions[0]?.product_ids.sort()).toEqual(['prod-cierra', 'prod-flexi']);
  });

  it('does NOT flag same product_id (real duplicate, not a collision)', () => {
    const collisions = findEanCollisions([
      {
        ean: '7793253038106',
        supermarket_id: 'rosental',
        day: '2026-07-20',
        product_id: 'same-prod',
      },
      {
        ean: '7793253038106',
        supermarket_id: 'rosental',
        day: '2026-07-20',
        product_id: 'same-prod',
      },
    ]);
    expect(collisions).toHaveLength(0);
  });

  it('ignores blank EANs and different days/chains', () => {
    expect(
      findEanCollisions([
        { ean: '', supermarket_id: 'rosental', day: '2026-07-20', product_id: 'a' },
        { ean: '', supermarket_id: 'rosental', day: '2026-07-20', product_id: 'b' },
        {
          ean: '7790117000071',
          supermarket_id: 'rosental',
          day: '2026-07-20',
          product_id: 'a',
        },
        {
          ean: '7790117000071',
          supermarket_id: 'makro',
          day: '2026-07-20',
          product_id: 'b',
        },
      ]),
    ).toHaveLength(0);
  });
});

describe('isRevistaSnapshotSource', () => {
  it('recognises revista sources only', () => {
    expect(isRevistaSnapshotSource('revista')).toBe(true);
    expect(isRevistaSnapshotSource('revista-carry-forward')).toBe(true);
    expect(isRevistaSnapshotSource('instore')).toBe(false);
    expect(isRevistaSnapshotSource('manual')).toBe(false);
    expect(isRevistaSnapshotSource(null)).toBe(false);
  });
});

describe('buenosAiresDate', () => {
  it('returns YYYY-MM-DD', () => {
    expect(buenosAiresDate(new Date('2026-07-20T15:00:00.000Z'))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('lastBaDays', () => {
  it('includes today and the previous N-1 calendar days', () => {
    const days = lastBaDays(3, new Date('2026-07-21T18:00:00.000Z'));
    expect([...days].sort()).toEqual(['2026-07-19', '2026-07-20', '2026-07-21']);
  });

  it('clamps n to at least 1', () => {
    const days = lastBaDays(0, new Date('2026-07-21T18:00:00.000Z'));
    expect([...days]).toEqual(['2026-07-21']);
  });
});
