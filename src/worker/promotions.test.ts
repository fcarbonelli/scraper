/**
 * Regression tests for promotion flattening.
 *
 * The headline case is the bug that took out every Carrefour product: a 15%
 * "Tarjeta Carrefour" teaser (discountPct = 15) was being written straight into
 * `unit_discount numeric(5,4)`, which can only hold values < 10 -> Postgres
 * 22003 "numeric field overflow". These tests pin the percent->fraction
 * conversion, the clamping safety net, and the offer-price math.
 */

import { describe, it, expect } from 'vitest';
import {
  flattenPromotions,
  discountPctToFraction,
} from './promotions.js';
import type { Promotion } from '../adapters/types.js';

const promo = (over: Partial<Promotion>): Promotion => ({
  type: 'discount',
  description: 'test',
  ...over,
});

describe('discountPctToFraction', () => {
  it('converts a percentage to a fraction', () => {
    expect(discountPctToFraction(15)).toBe(0.15);
    expect(discountPctToFraction(7.5)).toBe(0.075);
  });

  it('returns null for missing / zero / negative / NaN', () => {
    expect(discountPctToFraction(null)).toBeNull();
    expect(discountPctToFraction(undefined)).toBeNull();
    expect(discountPctToFraction(0)).toBeNull();
    expect(discountPctToFraction(-5)).toBeNull();
    expect(discountPctToFraction(Number.NaN)).toBeNull();
  });

  it('clamps malformed percentages so unit_discount can never overflow', () => {
    // A bad teaser of "150%" must clamp to 1.0 (fits numeric(5,4)), not 1.5.
    expect(discountPctToFraction(150)).toBe(1);
    expect(discountPctToFraction(100)).toBe(1);
  });
});

describe('flattenPromotions', () => {
  it('stores a 15% discount as the fraction 0.15 (the overflow regression)', () => {
    const flat = flattenPromotions(
      [promo({ description: 'Tarjeta Carrefour 15%', discountPct: 15 })],
      1000,
    );
    expect(flat.unit_discount).toBe(0.15);
    // and must be small enough to fit numeric(5,4)
    expect(Math.abs(flat.unit_discount as number)).toBeLessThan(10);
  });

  it('computes offer price from a percentage discount (not as a fraction)', () => {
    const flat = flattenPromotions(
      [promo({ description: '15% off', discountPct: 15 })],
      1000,
    );
    // 1000 * (1 - 0.15) = 850, NOT 1000 * (1 - 15) = -14000
    expect(flat.offer_price_1).toBe(850);
  });

  it('computes offer price from an absolute discount amount', () => {
    const flat = flattenPromotions(
      [promo({ description: '$200 off', discountAmount: 200 })],
      1000,
    );
    expect(flat.offer_price_1).toBe(800);
    expect(flat.unit_discount).toBeNull();
  });

  it('never produces a negative offer price', () => {
    const flat = flattenPromotions(
      [promo({ description: 'huge', discountAmount: 5000 })],
      1000,
    );
    expect(flat.offer_price_1).toBe(0);
  });

  it('picks the largest discount across promotions for unit_discount', () => {
    const flat = flattenPromotions(
      [
        promo({ description: 'a', discountPct: 10 }),
        promo({ description: 'b', discountPct: 25 }),
      ],
      1000,
    );
    expect(flat.unit_discount).toBe(0.25);
    expect(flat.promotion_1).toBe('a');
    expect(flat.promotion_2).toBe('b');
  });

  it('returns all-null for no promotions', () => {
    const flat = flattenPromotions([], 1000);
    expect(flat).toEqual({
      promotion_1: null,
      promotion_2: null,
      offer_price_1: null,
      offer_price_2: null,
      unit_discount: null,
    });
  });
});
