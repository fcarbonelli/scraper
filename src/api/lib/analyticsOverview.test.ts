/**
 * Unit tests for the Resumen analytics assembly (no DB).
 *
 * Fixture is two products × two chains over four BA days. Timestamps are
 * 15:00Z so they stay on the same America/Argentina/Buenos_Aires calendar day.
 */

import { describe, it, expect } from 'vitest';
import {
  assembleAnalyticsOverview,
  resolveAnalyticsWindow,
  type SnapRow,
} from './analyticsOverviewCompute.js';

function row(partial: Partial<SnapRow> & Pick<SnapRow, 'scrapedAt' | 'cellId'>): SnapRow {
  return {
    price: 100,
    listPrice: 100,
    inStock: true,
    status: 'ok',
    offer1: null,
    offer2: null,
    unitDiscount: null,
    promotion1: null,
    promotion2: null,
    reviewStatus: 'published',
    supermarketId: 'coto',
    supermarketName: 'COTO',
    productId: 'p-lavandina',
    productName: 'Lavandina 2L',
    ean: '7790000000001',
    category: 'Limpieza',
    ...partial,
  };
}

/** 15:00Z on `YYYY-MM-DD` → same BA calendar day (UTC−3). */
const at = (date: string) => `${date}T15:00:00.000Z`;

const RANGE = { from: '2026-08-01', to: '2026-08-04' };

/**
 * Day 1: both chains in stock at 100 / 110.
 * Day 2: Coto marks lavandina OOS; Jumbo stays at 110.
 * Day 3: Coto restocks at 120 (hike after OOS) + a named promo; Jumbo 110.
 * Day 4: Coto 120, Jumbo 105 (a drop).
 */
function fixture(): SnapRow[] {
  return [
    row({ scrapedAt: at('2026-08-01'), cellId: 'coto-lav', price: 100, listPrice: 100 }),
    row({
      scrapedAt: at('2026-08-01'),
      cellId: 'jumbo-lav',
      supermarketId: 'jumbo',
      supermarketName: 'JUMBO',
      price: 110,
      listPrice: 110,
    }),
    row({
      scrapedAt: at('2026-08-02'),
      cellId: 'coto-lav',
      price: null,
      listPrice: null,
      inStock: false,
      status: 'out_of_stock',
    }),
    row({
      scrapedAt: at('2026-08-02'),
      cellId: 'jumbo-lav',
      supermarketId: 'jumbo',
      supermarketName: 'JUMBO',
      price: 110,
      listPrice: 110,
    }),
    row({
      scrapedAt: at('2026-08-03'),
      cellId: 'coto-lav',
      price: 80,
      listPrice: 120,
      offer1: 80,
      promotion1: '20% off',
      unitDiscount: 0.3333,
    }),
    row({
      scrapedAt: at('2026-08-03'),
      cellId: 'jumbo-lav',
      supermarketId: 'jumbo',
      supermarketName: 'JUMBO',
      price: 110,
      listPrice: 110,
    }),
    row({
      scrapedAt: at('2026-08-04'),
      cellId: 'coto-lav',
      price: 120,
      listPrice: 120,
    }),
    row({
      scrapedAt: at('2026-08-04'),
      cellId: 'jumbo-lav',
      supermarketId: 'jumbo',
      supermarketName: 'JUMBO',
      price: 105,
      listPrice: 105,
    }),
  ];
}

describe('resolveAnalyticsWindow', () => {
  it('defaults to today and today−119d, then raises from to the floor', () => {
    const w = resolveAnalyticsWindow({}, '2026-09-02', '2026-07-31');
    expect(w.to).toBe('2026-09-02');
    expect(w.from).toBe('2026-07-31');
    expect(w.windowDays).toBe(30);
  });

  it('honors an explicit window that is already after the floor', () => {
    const w = resolveAnalyticsWindow(
      { from: '2026-08-01', to: '2026-08-15', window: 7 },
      '2026-09-02',
      '2026-07-31',
    );
    expect(w).toEqual({ from: '2026-08-01', to: '2026-08-15', windowDays: 7 });
  });
});

describe('assembleAnalyticsOverview', () => {
  it('returns a zeroed payload when there are no rows', () => {
    const o = assembleAnalyticsOverview([], RANGE, 3);
    expect(o.range).toEqual({ from: RANGE.from, to: RANGE.to, days: 4 });
    expect(o.basket.constituents).toBe(0);
    expect(o.basket.points).toEqual([]);
    expect(o.availability.chronic).toEqual([]);
    expect(o.movers.topIncreases).toEqual([]);
    expect(o.categories).toEqual([]);
    expect(o.competitiveness.chains).toEqual([]);
  });

  it('builds a Laspeyres basket (base 100) from day-0 constituents', () => {
    const o = assembleAnalyticsOverview(fixture(), RANGE, 3);
    expect(o.range).toEqual({ from: '2026-08-01', to: '2026-08-04', days: 4 });
    expect(o.basket.constituents).toBe(2);
    expect(o.basket.points).toHaveLength(4);
    expect(o.basket.points[0]!.index).toBe(100);
    // Day 0 basket = 100+110=210. Day 3 = 120+105=225 → 107.14
    expect(o.basket.points[3]!.index).toBe(107.14);
    expect(o.basket.currentBasketArs).toBe(225);
    expect(o.basket.nominalChangePct).toBe(7.1);
  });

  it('counts an OOS day against availability and carries the last price', () => {
    const o = assembleAnalyticsOverview(fixture(), RANGE, 3);
    expect(o.availability.points).toHaveLength(4);
    // Day 2: Coto OOS, Jumbo in stock → 50%
    expect(o.availability.points[1]!.availabilityPct).toBe(50);
    expect(o.availability.points[1]!.oosCount).toBe(1);
    // LOCF: Coto's day-2 carried price is still 100, so the basket doesn't drop.
    expect(o.basket.points[1]!.index).toBe(100);
  });

  it('flags a named/markdown promo and reports movers over the window', () => {
    const o = assembleAnalyticsOverview(fixture(), RANGE, 3);
    expect(o.promotions.points[2]!.promoSharePct).toBe(50);
    expect(o.promotions.points[2]!.avgDiscountPct).toBeGreaterThan(0);

    // Window=3: compare day 4 vs day 1. Coto 100→120 (+20%), Jumbo 110→105 (−4.5%).
    expect(o.movers.windowDays).toBe(3);
    expect(o.movers.topIncreases[0]!.supermarketId).toBe('coto');
    expect(o.movers.topIncreases[0]!.changePct).toBe(20);
    expect(o.movers.topDecreases[0]!.supermarketId).toBe('jumbo');
    expect(o.movers.topDecreases[0]!.changePct).toBe(-4.5);
  });

  it('rolls category inflation and a two-chain competitiveness ranking', () => {
    const o = assembleAnalyticsOverview(fixture(), RANGE, 3);
    expect(o.categories).toHaveLength(1);
    expect(o.categories[0]!.category).toBe('Limpieza');
    expect(o.categories[0]!.products).toBe(1);
    expect(o.categories[0]!.spark[0]).toBe(100);

    expect(o.competitiveness.chains.map((c) => c.supermarketId).sort()).toEqual([
      'coto',
      'jumbo',
    ]);
    expect(o.competitiveness.ranking).toHaveLength(2);
    expect(o.competitiveness.ranking[0]!.rank).toBe(1);
  });
});
