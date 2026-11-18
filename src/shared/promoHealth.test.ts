/**
 * Unit tests for the publicación promo-health check (no DB).
 *
 * A chain that usually has offers and comes back empty, or much thinner,
 * is flagged. A chain that rarely promotes, a thin day, and a normal week
 * stay quiet.
 */

import { describe, expect, it } from 'vitest';
import {
  isOnPromo,
  judgePromoHealth,
  type PromoObservation,
} from './promoHealth.js';

const DATE = '2026-11-17';

function snap(
  partial: Partial<PromoObservation> &
    Pick<PromoObservation, 'supermarketId' | 'supermarketProductId' | 'scrapedAt'>,
): PromoObservation {
  return {
    supermarketName: partial.supermarketName ?? partial.supermarketId,
    price: partial.price ?? 100,
    listPrice: partial.listPrice ?? null,
    promotions: partial.promotions ?? [],
    ...partial,
  };
}

/** `count` mappings on one day, `promoted` of them carrying a promotion tag. */
function day(chain: string, dayIso: string, count: number, promoted: number): PromoObservation[] {
  return Array.from({ length: count }, (_, i) =>
    snap({
      supermarketId: chain,
      supermarketName: chain,
      supermarketProductId: `${chain}-${i}`,
      scrapedAt: `${dayIso}T12:00:00.000Z`,
      promotions: i < promoted ? [{ type: 'discount', description: '2do al 50%' }] : [],
    }),
  );
}

describe('isOnPromo', () => {
  it('counts a list price above the shelf price', () => {
    expect(isOnPromo({ price: 80, listPrice: 100, promotions: [] })).toBe(true);
  });

  it('counts a non-empty promotions array', () => {
    expect(
      isOnPromo({ price: 100, listPrice: null, promotions: [{ type: 'bundle' }] }),
    ).toBe(true);
  });

  it('ignores a full price with no promotion tag', () => {
    expect(isOnPromo({ price: 100, listPrice: 100, promotions: [] })).toBe(false);
  });
});

describe('judgePromoHealth', () => {
  const history = [
    ...day('coto', '2026-11-14', 100, 20),
    ...day('coto', '2026-11-15', 100, 20),
    ...day('coto', '2026-11-16', 100, 20),
    ...day('disco', '2026-11-14', 100, 20),
    ...day('disco', '2026-11-15', 100, 20),
    ...day('disco', '2026-11-16', 100, 20),
    ...day('jumbo', '2026-11-14', 100, 20),
    ...day('jumbo', '2026-11-15', 100, 18),
    ...day('jumbo', '2026-11-16', 100, 22),
    ...day('vea', '2026-11-14', 100, 1),
    ...day('vea', '2026-11-15', 100, 1),
    ...day('vea', '2026-11-16', 100, 1),
    ...day('dia', '2026-11-16', 100, 30),
  ];

  const today = [
    ...day('coto', DATE, 100, 0),
    ...day('disco', DATE, 100, 4),
    ...day('jumbo', DATE, 100, 19),
    ...day('vea', DATE, 100, 0),
    ...day('dia', DATE, 100, 0),
    ...day('atomo', DATE, 4, 0),
  ];

  const verdict = judgePromoHealth(DATE, today, history);

  it('flags a chain whose offers disappeared and one that thinned out', () => {
    expect(verdict.chains.map((c) => c.supermarket_id)).toEqual(['coto', 'disco']);
    expect(verdict.chains[0]).toMatchObject({
      reason: 'none_today',
      promoted_today: 0,
      share_today_pct: 0,
      share_baseline_pct: 20,
      drop_pct: 100,
      days_observed: 3,
    });
    expect(verdict.chains[1]).toMatchObject({
      reason: 'sharp_drop',
      promoted_today: 4,
      share_today_pct: 4,
      share_baseline_pct: 20,
      drop_pct: 80,
    });
  });

  it('judges only chains with a real promo baseline', () => {
    // coto, disco and jumbo. vea rarely promotes, dia has one prior day,
    // atomo did not price enough rows today.
    expect(verdict.evaluated).toBe(3);
  });

  it('keeps the later snapshot when a mapping was scraped twice the same day', () => {
    const afternoon = day('coto', '2026-11-16', 20, 0).map((row) => ({
      ...row,
      scrapedAt: '2026-11-16T18:00:00.000Z',
    }));
    const morning = snap({
      supermarketId: 'coto',
      supermarketProductId: 'coto-0',
      scrapedAt: '2026-11-16T10:00:00.000Z',
      promotions: [{ type: 'discount' }],
    });
    const result = judgePromoHealth(DATE, day('coto', DATE, 20, 0), [
      ...day('coto', '2026-11-14', 20, 10),
      ...day('coto', '2026-11-15', 20, 10),
      morning,
      ...afternoon,
    ]);
    // Morning's promo loses to the empty afternoon scrape: 20 of 60, not 21.
    expect(result.chains[0]?.share_baseline_pct).toBe(33.3);
  });

  it('ignores history on the run day and history outside the window', () => {
    const result = judgePromoHealth(DATE, day('coto', DATE, 20, 0), [
      ...day('coto', '2026-11-01', 20, 20),
      ...day('coto', DATE, 20, 20),
      ...day('coto', '2026-11-14', 20, 10),
      ...day('coto', '2026-11-15', 20, 10),
      ...day('coto', '2026-11-16', 20, 10),
    ]);
    expect(result.chains[0]?.share_baseline_pct).toBe(50);
    expect(result.chains[0]?.days_observed).toBe(3);
  });

  it('treats a markdown list price as an offer', () => {
    const history = ['2026-11-14', '2026-11-15', '2026-11-16'].flatMap((dayIso) =>
      day('coto', dayIso, 20, 0).map((row) => ({ ...row, listPrice: 150, price: 100 })),
    );
    const result = judgePromoHealth(DATE, day('coto', DATE, 20, 0), history);
    expect(result.chains[0]).toMatchObject({
      reason: 'none_today',
      share_baseline_pct: 100,
    });
  });
});
