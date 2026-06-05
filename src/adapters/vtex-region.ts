/**
 * VTEX regionalization helper.
 *
 * VTEX stores (Carrefour, Vea, Jumbo, Disco, Día, Libertad, ...) filter product
 * availability AND price by the shopper's "region". A region is resolved from a
 * postal code:
 *
 *   GET /api/checkout/pub/regions?country=ARG&postalCode=<cp>
 *     -> [{ "id": "<regionId>", "sellers": [...] }]
 *
 * The returned `regionId` (a base64 blob like "U1cj...") is then passed to the
 * catalog search so results are scoped to the sellers that serve that region:
 *
 *   GET /api/catalog_system/pub/products/search?fq=productId:X&regionId=<id>
 *
 * Without a regionId the catalog returns the store's default sales channel,
 * which can report a product as empty / unavailable / price-less even when it's
 * in stock in some region. That is exactly the "missing / no price / out of
 * stock" symptom this module exists to fix.
 *
 * Confirmed live against Carrefour AR (2026-06): the regions endpoint returns a
 * regionId and the catalog search honors it. Only the host changes for other
 * VTEX stores.
 */

const REQUEST_TIMEOUT_MS = 15_000;
const USER_AGENT =
  'Mozilla/5.0 (compatible; PriceScraperBot/1.0; +https://example.com/bot)';
/** regionId is stable for a postal code; refresh at most once a day. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface RegionCacheEntry {
  regionId: string | null;
  expiresAt: number;
}

/** Module-level cache so we resolve each (store, postalCode) at most once/day. */
const regionCache = new Map<string, RegionCacheEntry>();

/** Minimal shape of the regions endpoint response. */
interface VtexRegion {
  id?: string;
}

/**
 * Resolve a VTEX `regionId` for a postal code at a given store base URL.
 *
 * Cached per (baseUrl, postalCode). Returns `null` when no region serves the CP
 * or the lookup fails — callers should treat null as "can't regionalize this
 * zone" and move on (the geo-fallback runner does this automatically).
 */
export async function resolveRegionId(
  baseUrl: string,
  postalCode: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const key = `${baseUrl}|${postalCode}`;
  const cached = regionCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.regionId;

  const url = `${baseUrl}/api/checkout/pub/regions?country=ARG&postalCode=${encodeURIComponent(
    postalCode,
  )}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  if (signal) {
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  let regionId: string | null = null;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        'Accept-Language': 'es-AR,es;q=0.9',
      },
      signal: controller.signal,
    });
    if (res.ok) {
      const body = (await res.json()) as VtexRegion[];
      const first = Array.isArray(body) ? body[0] : undefined;
      regionId = first && typeof first.id === 'string' && first.id !== '' ? first.id : null;
    }
  } catch {
    // Network/timeout — treat as "no region", caller falls back. We still
    // cache the null below so a flaky zone doesn't get hammered every product.
    regionId = null;
  } finally {
    clearTimeout(timeoutId);
  }

  regionCache.set(key, { regionId, expiresAt: Date.now() + CACHE_TTL_MS });
  return regionId;
}

/**
 * Append `regionId` (and an optional sales channel) to a VTEX catalog search
 * URL, returning the regionalized URL.
 */
export function withRegion(
  searchUrl: string,
  regionId: string,
  salesChannel?: string,
): string {
  const u = new URL(searchUrl);
  u.searchParams.set('regionId', regionId);
  if (salesChannel) u.searchParams.set('sc', salesChannel);
  return u.toString();
}

/** Clear the region cache. Intended for tests and manual refreshes. */
export function clearRegionCache(): void {
  regionCache.clear();
}
