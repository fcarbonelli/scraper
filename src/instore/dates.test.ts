/**
 * Unit tests for Buenos Aires calendar-day helpers (no DB).
 */

import { describe, it, expect } from 'vitest';
import {
  baDayRangeUtc,
  baDateRangeUtc,
  buenosAiresDate,
  isoWeekLabel,
  aggregateWeeklyStats,
} from './dates.js';

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

describe('isoWeekLabel', () => {
  it('labels a Monday in late August as 2026-W35', () => {
    expect(isoWeekLabel('2026-08-24')).toBe('2026-W35');
  });

  it('keeps a Sunday in the same ISO week as the preceding Monday', () => {
    expect(isoWeekLabel('2026-08-30')).toBe('2026-W35');
  });

  it('assigns late December to the next ISO year when the week belongs there', () => {
    // 2025-12-29 is a Monday; that week contains 2026-01-01 → 2026-W01.
    expect(isoWeekLabel('2025-12-29')).toBe('2026-W01');
  });
});

describe('aggregateWeeklyStats', () => {
  it('counts pending+approved entries per supermarket and ISO week', () => {
    const rows = aggregateWeeklyStats([
      {
        supermarket_id: 'diarco',
        supermarket_name: 'DIARCO',
        created_at: '2026-08-24T15:00:00.000Z',
        review_status: 'pending',
      },
      {
        supermarket_id: 'diarco',
        supermarket_name: 'DIARCO',
        created_at: '2026-08-25T15:00:00.000Z',
        review_status: 'approved',
      },
      {
        supermarket_id: 'nini',
        supermarket_name: 'NINI',
        created_at: '2026-08-24T15:00:00.000Z',
        review_status: 'pending',
      },
      {
        supermarket_id: 'diarco',
        supermarket_name: 'DIARCO',
        created_at: '2026-08-24T16:00:00.000Z',
        review_status: 'rejected',
      },
    ]);
    expect(rows).toEqual([
      { supermarket_id: 'diarco', supermarket_name: 'DIARCO', week: '2026-W35', count: 2 },
      { supermarket_id: 'nini', supermarket_name: 'NINI', week: '2026-W35', count: 1 },
    ]);
  });
});
