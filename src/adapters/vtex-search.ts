/**
 * Shared VTEX EAN search helper.
 *
 * Most Argentine supermarkets (Carrefour, Vea, Jumbo, Disco, Changomas, Día,
 * Libertad, etc.) run on the VTEX commerce platform, which exposes a standard
 * catalog search API:
 *
 *   GET /api/catalog_system/pub/products/search?fq=alternateIds_Ean:<ean>
 *
 * This returns the full product array (same shape as fq=productId:X). From it
 * we can derive the canonical product URL (`/<linkText>/p`).
 *
 * Usage in any VTEX adapter:
 *
 *   import { vtexSearchByEan } from './vtex-search.js';
 *
 *   const adapter: SupermarketAdapter = {
 *     // ...
 *     searchByEan: (ean, signal) => vtexSearchByEan('https://www.carrefour.com.ar', ean, signal),
 *   };
 */

const REQUEST_TIMEOUT_MS = 15_000;
const USER_AGENT =
  'Mozilla/5.0 (compatible; PriceScraperBot/1.0; +https://example.com/bot)';

import type { EanSearchResult } from './types.js';

/**
 * Search a VTEX store by EAN and return the canonical product URL + productId,
 * or null if the product isn't in this store's catalog.
 *
 * Returns the `productId` as `externalId` so the discover script can pass it
 * directly to the ingest pipeline, skipping the extra pagetype HTTP call.
 */
export async function vtexSearchByEan(
  baseUrl: string,
  ean: string,
  signal?: AbortSignal,
  userAgent: string = USER_AGENT,
  salesChannel?: number,
): Promise<EanSearchResult | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  if (signal) {
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  // Some VTEX stores (e.g. El Abastecedor) hide part of their catalog behind a
  // non-default sales channel; pass `salesChannel` so discovery can see it.
  const url =
    `${baseUrl}/api/catalog_system/pub/products/search?fq=alternateIds_Ean:${encodeURIComponent(ean)}` +
    (salesChannel !== undefined ? `&sc=${salesChannel}` : '');

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': userAgent,
        Accept: 'application/json',
        'Accept-Language': 'es-AR,es;q=0.9',
      },
      signal: controller.signal,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) return null;

  let body: VtexSearchProduct[];
  try {
    body = (await res.json()) as VtexSearchProduct[];
  } catch {
    return null;
  }

  const product = body[0];
  if (!product?.linkText) return null;

  return {
    url: `${baseUrl}/${product.linkText}/p`,
    externalId: product.productId,
  };
}

/** Minimal shape — only the fields we need for URL derivation. */
interface VtexSearchProduct {
  productId?: string;
  linkText?: string;
  link?: string;
}
