/**
 * Unit tests for the VTEX regionalization helper. Network is mocked via a
 * stubbed global `fetch`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveRegionId, withRegion, clearRegionCache } from './vtex-region.js';

const BASE = 'https://www.example.com';

beforeEach(() => {
  clearRegionCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('withRegion', () => {
  it('appends regionId to a catalog search URL', () => {
    const url = `${BASE}/api/catalog_system/pub/products/search?fq=productId:1`;
    const out = withRegion(url, 'REG123');
    expect(out).toContain('fq=productId%3A1');
    expect(out).toContain('regionId=REG123');
  });

  it('appends the sales channel when provided', () => {
    const url = `${BASE}/api/catalog_system/pub/products/search?fq=productId:1`;
    const out = withRegion(url, 'REG123', '1');
    expect(out).toContain('regionId=REG123');
    expect(out).toContain('sc=1');
  });
});

describe('resolveRegionId', () => {
  it('returns the first region id from the regions endpoint', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => [{ id: 'REGION_A', sellers: [] }],
    })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    const id = await resolveRegionId(BASE, '5000');
    expect(id).toBe('REGION_A');
  });

  it('caches results per (baseUrl, postalCode)', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => [{ id: 'REGION_A' }],
    })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    await resolveRegionId(BASE, '5000');
    await resolveRegionId(BASE, '5000');
    expect(fetchMock).toHaveBeenCalledTimes(1); // second call served from cache
  });

  it('returns null on a non-ok response', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      json: async () => [],
    })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    const id = await resolveRegionId(BASE, '9999');
    expect(id).toBeNull();
  });

  it('returns null when the request throws', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    const id = await resolveRegionId(BASE, '1414');
    expect(id).toBeNull();
  });
});
