/**
 * Regression tests for the DIPA/Parodi adapter's redirect handling.
 *
 * Root cause of the client-reported "productos discontinuados automáticamente":
 * PrestaShop 301/302-redirects a stale-but-valid product URL to the SAME
 * product's current canonical URL after a slug/category change. The adapter
 * used to treat EVERY 3xx as `product_not_found`, so live, in-stock products
 * whose stored URL had drifted were marked as gaps every day.
 *
 * These tests pin the fix: follow a redirect to the same product's canonical
 * URL (same leading id), but still report `product_not_found` for a genuine
 * "product gone" redirect to home / a category / a different product.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { parodiAdapter } from './parodi.js';
import { ScrapeError } from '../shared/errors.js';
import type { Logger } from '../shared/logger.js';
import type { ScrapeContext } from './types.js';

const log = {
  info: () => undefined,
  debug: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => log,
} as unknown as Logger;

const STALE_URL =
  'https://cordoba.dipa.ar/limpieza/7201-slug-viejo-7793253005054.html';
const CANONICAL_URL =
  'https://cordoba.dipa.ar/desinfectantes-en-aerosol/7201-desinfayudin-aerosol-original-332cc-7793253005054.html';

const PRODUCT_HTML = `<!doctype html><html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Product","name":"DESINF.AYUDIN AEROSOL ORIGINAL 332CC","sku":"7201","gtin13":"7793253005054","brand":{"name":"AYUDIN"},"offers":{"@type":"Offer","price":"2797.15","priceCurrency":"ARS","availability":"https://schema.org/InStock"}}
</script></head><body>ok</body></html>`;

/** Minimal Response-like stub for the mocked global fetch. */
function resp(opts: { status: number; location?: string; body?: string }): Response {
  return {
    status: opts.status,
    ok: opts.status >= 200 && opts.status < 300,
    url: '',
    headers: { get: (name: string) => (name.toLowerCase() === 'location' ? opts.location ?? null : null) },
    text: async () => opts.body ?? '',
  } as unknown as Response;
}

function ctxFor(url: string): ScrapeContext {
  return {
    supermarketProductId: 'test',
    externalId: '7201',
    externalUrl: url,
    config: { id: 'parodi', name: 'Parodi', baseUrl: null, rateLimitMs: 0, concurrency: 1, config: {} },
    logger: log,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('parodi adapter — canonical redirect handling', () => {
  it('follows a redirect to the SAME product canonical URL and scrapes it', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === STALE_URL) return resp({ status: 302, location: CANONICAL_URL });
      if (url === CANONICAL_URL) return resp({ status: 200, body: PRODUCT_HTML });
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await parodiAdapter.scrape(ctxFor(STALE_URL));
    expect(result.price).toBe(2797.15);
    expect(result.inStock).toBe(true);
    expect(result.productInfo?.ean).toBe('7793253005054');
    // one redirect + one real fetch
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports product_not_found when the redirect goes to the home page', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => resp({ status: 302, location: 'https://cordoba.dipa.ar/' })),
    );
    await expect(parodiAdapter.scrape(ctxFor(STALE_URL))).rejects.toMatchObject({
      type: 'product_not_found',
    } satisfies Partial<ScrapeError>);
  });

  it('reports product_not_found when the redirect goes to a different product', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        resp({
          status: 301,
          location:
            'https://cordoba.dipa.ar/limpieza/9999-otro-producto-7790000000000.html',
        }),
      ),
    );
    await expect(parodiAdapter.scrape(ctxFor(STALE_URL))).rejects.toMatchObject({
      type: 'product_not_found',
    });
  });

  it('scrapes a normal 200 product page without any redirect', async () => {
    const fetchMock = vi.fn(async () => resp({ status: 200, body: PRODUCT_HTML }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await parodiAdapter.scrape(ctxFor(CANONICAL_URL));
    expect(result.price).toBe(2797.15);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
