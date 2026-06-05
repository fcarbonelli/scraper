/**
 * Tests for the ScrapeResult invariants checker.
 */

import { describe, it, expect } from 'vitest';
import { validateScrapeResult } from './validate.js';
import type { ScrapeResult } from './types.js';

const base = (over: Partial<ScrapeResult>): ScrapeResult => ({
  price: 1000,
  inStock: true,
  currency: 'ARS',
  tierUsed: 'api',
  ...over,
});

describe('validateScrapeResult', () => {
  it('accepts a healthy result', () => {
    const r = validateScrapeResult(base({}));
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('rejects non-positive / non-finite prices', () => {
    expect(validateScrapeResult(base({ price: 0 })).ok).toBe(false);
    expect(validateScrapeResult(base({ price: -5 })).ok).toBe(false);
    expect(validateScrapeResult(base({ price: Number.NaN })).ok).toBe(false);
  });

  it('rejects prices that exceed the numeric(12,2) column', () => {
    expect(validateScrapeResult(base({ price: 1e11 })).ok).toBe(false);
  });

  it('flags a discountPct above 100 as an error (overflow smell)', () => {
    const r = validateScrapeResult(
      base({ promotions: [{ type: 'discount', description: 'x', discountPct: 150 }] }),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('discountPct'))).toBe(true);
  });

  it('accepts a normal percentage discount', () => {
    const r = validateScrapeResult(
      base({ promotions: [{ type: 'discount', description: 'x', discountPct: 15 }] }),
    );
    expect(r.ok).toBe(true);
  });

  it('warns (but does not fail) when listPrice < price', () => {
    const r = validateScrapeResult(base({ listPrice: 500, price: 1000 }));
    expect(r.ok).toBe(true);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('requires currency and a boolean inStock', () => {
    expect(validateScrapeResult(base({ currency: '' })).ok).toBe(false);
    expect(
      validateScrapeResult(base({ inStock: undefined as unknown as boolean })).ok,
    ).toBe(false);
  });
});
