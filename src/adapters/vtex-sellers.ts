/**
 * VTEX store-seller ("sucursal") fallback via the checkout simulation API.
 *
 * WHY
 * ---
 * Some VTEX storefronts split inventory between a single online DELIVERY seller
 * ("1") and many per-branch PICKUP sellers. ChangoMas / masonline.com.ar is the
 * clear case: seller "1" ("MasOnline") is the only one the public catalog API
 * ever returns, yet ~half our tracked products are out of stock on it while the
 * physical CABA branches still LIST them with a real price. The regionId
 * mechanism (see vtex-region.ts) does NOT help — masonline's catalog ignores
 * regionId and keeps returning only seller "1".
 *
 * The reliable way to read a specific branch's price/stock is the checkout
 * simulation endpoint:
 *
 *   POST /api/checkout/pub/orderForms/simulation
 *     { items: [{ id: <sku>, quantity: 1, seller: <storeSellerId> }],
 *       country: "ARG", postalCode: <cp> }
 *
 * which returns, per seller, `availability` ("available" | "withoutStock" | …)
 * and `sellingPrice` (in CENTS). The branch sellers that serve a postal code
 * come from the regions endpoint (same one vtex-region.ts uses).
 *
 * PICKING A PRICE
 * ---------------
 * Branch sellers are not equal: some carry a STALE price list (years old, far
 * too low — e.g. $33 for a product that really costs $1300), while the live
 * branch carries the true price. Argentina's high inflation makes the freshest
 * price the HIGHEST, so among the branches that carry a SKU we take the MAX
 * price. Empirically that always picked the live branch (its price matched our
 * own in-stock history to within a few percent) and skipped the stale outliers.
 *
 * Availability is reported truthfully: we mark in-stock only when a branch is
 * actually `available`. If no branch is purchasable right now we still return
 * the (max) carried price with inStock=false, so the product shows the same
 * price the site shows instead of a blank — and it flips to in-stock on its own
 * the day a branch restocks.
 */

const REQUEST_TIMEOUT_MS = 15_000;
/** Region→sellers is stable for a postal code; refresh at most once a day. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface SellerCacheEntry {
  sellers: string[];
  expiresAt: number;
}
const sellerCache = new Map<string, SellerCacheEntry>();

interface RegionsResponse {
  sellers?: Array<{ id?: string }>;
}

/** The chosen branch offer for a SKU. */
export interface StoreOffer {
  /** Selling price in the store currency (already converted from cents). */
  price: number;
  /** True only when the chosen branch is actually purchasable right now. */
  inStock: boolean;
  /** Winning branch seller id (kept in rawData for forensics). */
  seller: string;
  /** How many region branches carried the SKU (had a price). */
  carriedBy: number;
}

async function fetchJson(
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
): Promise<unknown | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Resolve the branch seller ids that serve a postal code, cached per
 * (baseUrl, postalCode) for a day. Returns [] when the lookup fails.
 */
export async function resolveRegionSellers(
  baseUrl: string,
  postalCode: string,
  userAgent: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const key = `${baseUrl}|${postalCode}`;
  const cached = sellerCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.sellers;

  const url = `${baseUrl}/api/checkout/pub/regions?country=ARG&postalCode=${encodeURIComponent(
    postalCode,
  )}`;
  const body = await fetchJson(
    url,
    { method: 'GET', headers: { 'User-Agent': userAgent, Accept: 'application/json' } },
    signal,
  );
  const first = Array.isArray(body) ? (body[0] as RegionsResponse | undefined) : undefined;
  const sellers = (first?.sellers ?? [])
    .map((s) => s.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);

  sellerCache.set(key, { sellers, expiresAt: Date.now() + CACHE_TTL_MS });
  return sellers;
}

interface SimulationItem {
  availability?: string;
  sellingPrice?: number | null;
}
interface SimulationResponse {
  items?: SimulationItem[];
}

/** Simulate one SKU for one branch seller; null price = branch doesn't carry it. */
async function simulateSeller(
  baseUrl: string,
  sku: string,
  seller: string,
  postalCode: string,
  userAgent: string,
  signal: AbortSignal | undefined,
): Promise<{ available: boolean; price: number | null }> {
  const body = (await fetchJson(
    `${baseUrl}/api/checkout/pub/orderForms/simulation?RnbBehavior=0`,
    {
      method: 'POST',
      headers: {
        'User-Agent': userAgent,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        items: [{ id: sku, quantity: 1, seller }],
        country: 'ARG',
        postalCode,
      }),
    },
    signal,
  )) as SimulationResponse | null;

  const item = body?.items?.[0];
  if (!item) return { available: false, price: null };
  // sellingPrice is in cents; <=0 means the branch doesn't really carry it.
  const price =
    typeof item.sellingPrice === 'number' && item.sellingPrice > 0
      ? item.sellingPrice / 100
      : null;
  return { available: item.availability === 'available', price };
}

/**
 * Sweep the branch sellers serving `postalCode` for `sku` and pick an offer:
 *   1. If any branch is purchasable now, choose the max-priced available branch
 *      (skips stale-low prices) → inStock: true.
 *   2. Otherwise choose the max-priced branch that merely carries it →
 *      inStock: false (real price, honestly out of stock).
 * Returns null when no branch carries the SKU at all.
 */
export async function pickStoreOffer(params: {
  baseUrl: string;
  sku: string;
  postalCode: string;
  userAgent: string;
  signal?: AbortSignal;
  sellers?: string[];
}): Promise<StoreOffer | null> {
  const { baseUrl, sku, postalCode, userAgent, signal } = params;
  const sellers =
    params.sellers ?? (await resolveRegionSellers(baseUrl, postalCode, userAgent, signal));
  if (sellers.length === 0) return null;

  const carried: Array<{ seller: string; price: number; available: boolean }> = [];
  for (const seller of sellers) {
    const r = await simulateSeller(baseUrl, sku, seller, postalCode, userAgent, signal);
    if (r.price !== null) carried.push({ seller, price: r.price, available: r.available });
  }
  if (carried.length === 0) return null;

  const available = carried.filter((c) => c.available);
  const pool = available.length > 0 ? available : carried;
  // Freshest-in-inflation heuristic: the highest price is the live branch; the
  // low ones are stale price lists we want to skip.
  const chosen = pool.reduce((best, c) => (c.price > best.price ? c : best));

  return {
    price: chosen.price,
    inStock: available.length > 0,
    seller: chosen.seller,
    carriedBy: carried.length,
  };
}

/** Clear the region-sellers cache. Intended for tests and manual refreshes. */
export function clearSellerCache(): void {
  sellerCache.clear();
}
