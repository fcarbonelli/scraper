/**
 * Unit tests for the location-fallback runner.
 *
 * These exercise the "prefer-default" policy without any network access by
 * passing a fake `attempt` that returns/throws per zone.
 */

import { describe, it, expect, vi } from 'vitest';
import { runWithGeoFallback } from './geo-retry.js';
import { ScrapeError } from '../shared/errors.js';
import type { Logger } from '../shared/logger.js';
import type { ScrapeResult } from './types.js';
import type { Zone } from './zones.js';

/** No-op logger stub good enough for the runner (only info/debug are used). */
const log = {
  info: () => undefined,
  debug: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => log,
} as unknown as Logger;

/** Build a minimal in-stock ScrapeResult. */
function ok(price: number): ScrapeResult {
  return { price, inStock: true, currency: 'ARS', tierUsed: 'api' };
}

/** Build a minimal out-of-stock ScrapeResult (has a price, just not available). */
function oos(price: number): ScrapeResult {
  return { price, inStock: false, currency: 'ARS', tierUsed: 'api' };
}

describe('runWithGeoFallback', () => {
  it('returns the default-zone result without sweeping when it is in stock', async () => {
    const attempt = vi.fn(async (_zone: Zone | null) => ok(100));
    const res = await runWithGeoFallback({ logger: log, config: undefined, attempt });

    expect(res.price).toBe(100);
    expect(res.zoneUsed).toBeUndefined();
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(attempt).toHaveBeenCalledWith(null);
  });

  it('sweeps zones when the default is out of stock and tags the winning zone', async () => {
    const attempt = vi.fn(async (zone: Zone | null) => {
      if (zone === null) return oos(100); // default: priced but out of stock
      if (zone.id === 'caba') return oos(100); // first zone also OOS
      if (zone.id === 'gba-oeste') return ok(120); // this one has stock
      return oos(100);
    });

    const res = await runWithGeoFallback({ logger: log, config: undefined, attempt });

    expect(res.inStock).toBe(true);
    expect(res.price).toBe(120);
    expect(res.zoneUsed).toBe('gba-oeste');
  });

  it('sweeps zones when the default throws product_not_found', async () => {
    const attempt = vi.fn(async (zone: Zone | null) => {
      if (zone === null) throw new ScrapeError('product_not_found', 'not here');
      if (zone.id === 'caba') return ok(80);
      return oos(80);
    });

    const res = await runWithGeoFallback({ logger: log, config: undefined, attempt });
    expect(res.price).toBe(80);
    expect(res.zoneUsed).toBe('caba');
  });

  it('keeps the default (out of stock) result when no zone has stock', async () => {
    const attempt = vi.fn(async (zone: Zone | null) => {
      if (zone === null) return oos(99);
      return oos(99); // every zone out of stock too
    });

    const res = await runWithGeoFallback({ logger: log, config: undefined, attempt });
    expect(res.inStock).toBe(false);
    expect(res.price).toBe(99);
    expect(res.zoneUsed).toBeUndefined();
  });

  it('throws region_unavailable when the default threw and no zone has stock', async () => {
    const attempt = vi.fn(async (zone: Zone | null) => {
      if (zone === null) throw new ScrapeError('price_missing', 'no price');
      throw new ScrapeError('product_not_found', 'not in this zone');
    });

    await expect(
      runWithGeoFallback({ logger: log, config: undefined, attempt }),
    ).rejects.toMatchObject({ type: 'region_unavailable' });
  });

  it('rethrows non-zone errors (e.g. network) without sweeping', async () => {
    const attempt = vi.fn(async (_zone: Zone | null) => {
      throw new ScrapeError('network_timeout', 'timeout');
    });

    await expect(
      runWithGeoFallback({ logger: log, config: undefined, attempt }),
    ).rejects.toMatchObject({ type: 'network_timeout' });
    expect(attempt).toHaveBeenCalledTimes(1); // default only, no zone sweep
  });

  it('does not sweep when geoRetry is disabled in config', async () => {
    const attempt = vi.fn(async (_zone: Zone | null) => oos(100));
    const res = await runWithGeoFallback({
      logger: log,
      config: { geoRetry: { enabled: false } },
      attempt,
    });

    expect(res.inStock).toBe(false);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('caps the sweep at maxZonesToTry', async () => {
    const attempt = vi.fn(async (_zone: Zone | null) => oos(100));
    await runWithGeoFallback({
      logger: log,
      config: { geoRetry: { maxZonesToTry: 2 } },
      attempt,
    });

    // 1 default + 2 zones = 3 total attempts.
    expect(attempt).toHaveBeenCalledTimes(3);
  });
});
