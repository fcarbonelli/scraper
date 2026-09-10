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
 *
 * Caching policy (see resolveRegionId): STABLE outcomes (a resolved regionId, or
 * a definitive "no region serves this CP") are cached for a day; TRANSIENT
 * failures (timeout / 429 / 5xx / network) are cached only briefly and retried.
 * This prevents one flaky lookup at the start of the daily run from silently
 * disabling geo-fallback for every product for the rest of the day.
 */

const REQUEST_TIMEOUT_MS = 15_000;
const USER_AGENT =
  'Mozilla/5.0 (compatible; PriceScraperBot/1.0; +https://example.com/bot)';

/**
 * A resolved regionId (and a definitive "no region serves this CP") is a stable
 * fact — cache it for a day so we resolve each (store, postalCode) at most once.
 */
const STABLE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * A TRANSIENT failure (timeout / 429 / 5xx / network) is NOT a stable fact.
 * Caching it for a full day is what silently disabled geo-fallback in prod: the
 * FIRST failed lookup of the daily run poisoned every subsequent product for the
 * rest of the day (and across all VTEX stores), so the zone sweep never ran even
 * though the endpoint recovered seconds later. We cache transient failures only
 * briefly — long enough to avoid hammering a struggling endpoint once per
 * product, short enough that the same daily run recovers as soon as it responds.
 */
const TRANSIENT_CACHE_TTL_MS = 60 * 1000;

/** Retry the (cheap) region lookup a couple of times before giving up. */
const MAX_ATTEMPTS = 3;
/** Backoff between attempts (ms); index i is the wait AFTER attempt i. */
const RETRY_BACKOFF_MS = [300, 800];

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

/** Outcome of a single region-endpoint call. */
type RegionAttempt =
  | { kind: 'ok'; regionId: string }
  | { kind: 'no_region' } // 2xx but the CP has no serving region (stable)
  | { kind: 'transient' }; // timeout / 429 / 5xx / network (not stable)

/** Await `ms`, resolving early (not throwing) if `signal` aborts. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/** One attempt at the regions endpoint. Classifies the result for caching. */
async function fetchRegionOnce(
  url: string,
  signal: AbortSignal | undefined,
  userAgent: string,
): Promise<RegionAttempt> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': userAgent,
        Accept: 'application/json',
        'Accept-Language': 'es-AR,es;q=0.9',
      },
      signal: controller.signal,
    });
    // Non-2xx (429 rate-limit, 5xx, WAF blocks, ...) is a transient condition,
    // not a definitive "no region for this CP".
    if (!res.ok) return { kind: 'transient' };
    const body = (await res.json()) as VtexRegion[];
    const first = Array.isArray(body) ? body[0] : undefined;
    const id = first && typeof first.id === 'string' && first.id !== '' ? first.id : null;
    return id ? { kind: 'ok', regionId: id } : { kind: 'no_region' };
  } catch {
    // Network error / timeout / abort — transient.
    return { kind: 'transient' };
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Resolve a VTEX `regionId` for a postal code at a given store base URL.
 *
 * Cached per (baseUrl, postalCode). Returns `null` when no region serves the CP
 * or the lookup ultimately fails — callers treat null as "can't regionalize
 * this zone" and move on (the geo-fallback runner does this automatically).
 *
 * Retries transient failures a few times and, crucially, only long-caches
 * STABLE outcomes (a resolved id, or a definitive "no region for this CP").
 * Transient failures are cached only briefly so one flaky lookup can't disable
 * the zone sweep for the whole daily run.
 */
export async function resolveRegionId(
  baseUrl: string,
  postalCode: string,
  signal?: AbortSignal,
  userAgent: string = USER_AGENT,
): Promise<string | null> {
  const key = `${baseUrl}|${postalCode}`;
  const cached = regionCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.regionId;

  const url = `${baseUrl}/api/checkout/pub/regions?country=ARG&postalCode=${encodeURIComponent(
    postalCode,
  )}`;

  let regionId: string | null = null;
  let stable = false;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const outcome = await fetchRegionOnce(url, signal, userAgent);
    if (outcome.kind === 'ok') {
      regionId = outcome.regionId;
      stable = true;
      break;
    }
    if (outcome.kind === 'no_region') {
      regionId = null;
      stable = true; // the CP genuinely has no serving region
      break;
    }
    // transient — back off and retry (unless this was the last attempt or we're aborting)
    if (signal?.aborted) break;
    if (attempt < MAX_ATTEMPTS - 1) {
      await delay(RETRY_BACKOFF_MS[attempt] ?? 800, signal);
    }
  }

  const ttl = stable ? STABLE_CACHE_TTL_MS : TRANSIENT_CACHE_TTL_MS;
  regionCache.set(key, { regionId, expiresAt: Date.now() + ttl });
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
