/**
 * Unit tests for in-store outlier detection (no DB).
 *
 * Covers the typo cases the review panel is for: extra/missing zero vs
 * last visit, first-visit vs other stores, and fallback to the EDP target.
 */

import { describe, it, expect } from 'vitest';
import {
  detectInStoreOutliers,
  DEFAULT_INSTORE_OUTLIER_OPTIONS,
  type InStoreOutlierItem,
} from './detectOutliers.js';

function item(overrides: Partial<InStoreOutlierItem> & { price: number }): InStoreOutlierItem {
  return {
    entryId: overrides.entryId ?? 'e1',
    visitId: overrides.visitId ?? 'v1',
    ean: overrides.ean ?? '7790001',
    name: overrides.name ?? 'Lavandina 2 L',
    brand: overrides.brand ?? 'AYUDIN',
    supermarketId: overrides.supermarketId ?? 'diarco',
    supermarketName: overrides.supermarketName ?? 'DIARCO',
    enteredBy: overrides.enteredBy ?? 'Juan',
    field: overrides.field ?? 'price',
    price: overrides.price,
    reviewStatus: overrides.reviewStatus ?? 'pending',
    createdAt: overrides.createdAt ?? '2026-08-24T15:00:00.000Z',
  };
}

const emptyTargets = new Map<string, number>();
const emptyHist = new Map<string, number[]>();
const canals = new Map<string, string>([
  ['diarco', 'MAY NACIONAL'],
  ['nini', 'MAY NACIONAL'],
]);

describe('detectInStoreOutliers', () => {
  it('flags an extra-zero typo against the same store\'s last visit', () => {
    const hist = new Map<string, number[]>([['diarco|7790001|price', [1500, 1480, 1520]]]);
    const flags = detectInStoreOutliers(
      [item({ price: 15000 })],
      hist,
      emptyHist,
      emptyTargets,
      canals,
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]!.source).toBe('self-history');
    expect(flags[0]!.deviation_pct).toBeGreaterThan(800);
    expect(flags[0]!.field).toBe('price');
  });

  it('flags a missing-zero typo (signed drop)', () => {
    const hist = new Map<string, number[]>([['diarco|7790001|price', [1500, 1500]]]);
    const flags = detectInStoreOutliers(
      [item({ price: 150 })],
      hist,
      emptyHist,
      emptyTargets,
      canals,
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]!.deviation_pct).toBeLessThan(-80);
  });

  it('does not flag a price within the threshold', () => {
    const hist = new Map<string, number[]>([['diarco|7790001|price', [1500, 1520]]]);
    const flags = detectInStoreOutliers(
      [item({ price: 1600 })],
      hist,
      emptyHist,
      emptyTargets,
      canals,
    );
    expect(flags).toHaveLength(0);
  });

  it('uses other stores when this store has no history (first visit)', () => {
    const cross = new Map<string, number[]>([['7790001|price', [1480, 1510, 1490]]]);
    const flags = detectInStoreOutliers(
      [item({ price: 14900 })],
      emptyHist,
      cross,
      emptyTargets,
      canals,
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]!.source).toBe('cross-store');
  });

  it('uses a same-day peer at another store as cross-store signal', () => {
    const flags = detectInStoreOutliers(
      [
        item({ entryId: 'e-diarco', supermarketId: 'diarco', price: 15000 }),
        item({ entryId: 'e-nini', supermarketId: 'nini', supermarketName: 'NINI', price: 1500 }),
      ],
      emptyHist,
      emptyHist,
      emptyTargets,
      canals,
    );
    const diarco = flags.find((f) => f.entry_id === 'e-diarco');
    expect(diarco).toBeDefined();
    expect(diarco!.source).toBe('cross-store');
    expect(Math.abs(diarco!.deviation_pct)).toBeGreaterThan(30);
  });

  it('falls back to the EDP target when there is no in-store history', () => {
    const targets = new Map<string, number>([['7790001|MAY', 1400]]);
    const flags = detectInStoreOutliers(
      [item({ price: 140 })],
      emptyHist,
      emptyHist,
      targets,
      canals,
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]!.source).toBe('target');
    expect(flags[0]!.baseline).toBe(1400);
  });

  it('skips a first-ever product with no peers and no target', () => {
    const flags = detectInStoreOutliers(
      [item({ price: 999 })],
      emptyHist,
      emptyHist,
      emptyTargets,
      canals,
    );
    expect(flags).toHaveLength(0);
  });

  it('prefers self-history over cross-store when both exist', () => {
    const self = new Map<string, number[]>([['diarco|7790001|price', [2000]]]);
    const cross = new Map<string, number[]>([['7790001|price', [10000, 10000]]]);
    const flags = detectInStoreOutliers(
      [item({ price: 2100 })],
      self,
      cross,
      emptyTargets,
      canals,
    );
    // 2100 vs 2000 is 5% — not an outlier against self-history.
    // Against cross-store (10000) it would be -79%. Preference matters.
    expect(flags).toHaveLength(0);
  });

  it('flags a wholesale typo independently of the regular price', () => {
    const hist = new Map<string, number[]>([
      ['diarco|7790001|price', [1500, 1500]],
      ['diarco|7790001|wholesale_price', [1300, 1320]],
    ]);
    const flags = detectInStoreOutliers(
      [
        item({ entryId: 'e1', field: 'price', price: 1510 }),
        item({ entryId: 'e1', field: 'wholesale_price', price: 13000 }),
      ],
      hist,
      emptyHist,
      emptyTargets,
      canals,
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]!.field).toBe('wholesale_price');
    expect(flags[0]!.price).toBe(13000);
  });

  it('sorts by |deviation_pct| descending', () => {
    const hist = new Map<string, number[]>([
      ['diarco|7790001|price', [1000]],
      ['diarco|7790002|price', [1000]],
    ]);
    const flags = detectInStoreOutliers(
      [
        item({ entryId: 'small', ean: '7790001', price: 1400 }),
        item({ entryId: 'big', ean: '7790002', price: 10000 }),
      ],
      hist,
      emptyHist,
      emptyTargets,
      canals,
    );
    expect(flags.map((f) => f.entry_id)).toEqual(['big', 'small']);
  });

  it('respects a higher threshold', () => {
    const hist = new Map<string, number[]>([['diarco|7790001|price', [1000]]]);
    const flags = detectInStoreOutliers(
      [item({ price: 1400 })],
      hist,
      emptyHist,
      emptyTargets,
      canals,
      { ...DEFAULT_INSTORE_OUTLIER_OPTIONS, threshold: 50 },
    );
    expect(flags).toHaveLength(0);
  });
});
