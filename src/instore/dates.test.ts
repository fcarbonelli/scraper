/**
 * Unit tests for Buenos Aires calendar-day helpers (no DB).
 */

import { describe, it, expect } from 'vitest';
import { baDayRangeUtc, baDateRangeUtc, buenosAiresDate } from './dates.js';

describe('baDayRangeUtc', () => {
  it('covers midnight-to-midnight Argentina time as a UTC half-open range', () => {
    const { fromUtc, toUtc } = baDayRangeUtc('2026-08-24');
    // AR is UTC-3, so 00:00 AR = 03:00 UTC same calendar day.
    expect(fromUtc).toBe('2026-08-24T03:00:00.000Z');
    expect(toUtc).toBe('2026-08-25T03:00:00.000Z');
  });
});

describe('baDateRangeUtc', () => {
  it('extends the exclusive end to the day after `to`', () => {
    const { fromUtc, toUtc } = baDateRangeUtc('2026-08-24', '2026-08-26');
    expect(fromUtc).toBe('2026-08-24T03:00:00.000Z');
    expect(toUtc).toBe('2026-08-27T03:00:00.000Z');
  });
});

describe('buenosAiresDate', () => {
  it('rolls a late-evening UTC instant back onto the AR calendar day', () => {
    // 01:30 UTC on the 25th is 22:30 on the 24th in Buenos Aires.
    expect(buenosAiresDate(new Date('2026-08-25T01:30:00.000Z'))).toBe('2026-08-24');
  });
});
