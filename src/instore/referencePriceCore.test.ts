/**
 * Unit tests for the in-store market-reference median (no DB).
 */

import { describe, it, expect } from 'vitest';
import { median, pickReferencePrice } from './referencePriceCore.js';

describe('median', () => {
  it('returns the middle value for an odd-length list', () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it('averages the two middle values for an even-length list', () => {
    expect(median([10, 20])).toBe(15);
  });
});

describe('pickReferencePrice', () => {
  it('prefers the MAY median and ignores older days at the same chain', () => {
    const ref = pickReferencePrice([
      { cadena: 'DIARCO', canal: 'MAY NACIONAL', price: 900, date: '2026-08-01' },
      { cadena: 'DIARCO', canal: 'MAY NACIONAL', price: 1500, date: '2026-08-20' },
      { cadena: 'NINI', canal: 'MAY NACIONAL', price: 1600, date: '2026-08-20' },
      { cadena: 'COTO', canal: 'SPM NACIONAL', price: 4000, date: '2026-08-20' },
    ]);
    // Latest per MAY chain: 1500, 1600 → median 1550. Coto is ignored.
    expect(ref).toBe(1550);
  });

  it('falls back to all channels when there is no MAY history', () => {
    const ref = pickReferencePrice([
      { cadena: 'COTO', canal: 'SPM NACIONAL', price: 2000, date: '2026-08-20' },
      { cadena: 'CARREFOUR', canal: 'SPM NACIONAL', price: 2200, date: '2026-08-20' },
    ]);
    expect(ref).toBe(2100);
  });

  it('returns null when there are no positive prices', () => {
    expect(pickReferencePrice([])).toBeNull();
    expect(pickReferencePrice([{ cadena: 'X', canal: 'MAY NACIONAL', price: 0, date: '2026-08-20' }])).toBeNull();
  });
});
