/**
 * Generic location-fallback runner shared by location-sensitive adapters.
 *
 * Implements the "prefer-default" price policy:
 *
 *   1. Try the DEFAULT zone (no region) first.
 *   2. If it yields an in-stock price -> return it. This is the common path and
 *      costs zero extra requests.
 *   3. Otherwise (the default threw product_not_found / price_missing, OR came
 *      back out-of-stock) iterate the zone list. The first zone that returns an
 *      in-stock price wins and is tagged via `result.zoneUsed`.
 *   4. If no zone yields stock:
 *        - return the default's result when it at least had a price (it was
 *          merely out of stock) so price trends stay continuous, OR
 *        - throw `region_unavailable` when the default had no offer at all and
 *          no zone produced one.
 *
 * So another zone's price is only ever adopted when the default zone had no
 * in-stock offer — which matches the operator's chosen policy.
 *
 * The runner is mechanism-agnostic: each adapter supplies an `attempt(zone)`
 * that knows how to apply that site's notion of a zone (VTEX regionId, a
 * sucursal cookie, a query param, ...). Adapters with no zone mechanism simply
 * never call this and scrape normally.
 */

import { ScrapeError } from '../shared/errors.js';
import type { Logger } from '../shared/logger.js';
import type { ScrapeResult } from './types.js';
import { loadGeoRetryConfig, type Zone } from './zones.js';

export interface GeoFallbackParams {
  logger: Logger;
  /** The `supermarkets.config` blob (for geoRetry / zones overrides). */
  config: Record<string, unknown> | undefined;
  /**
   * Perform one scrape attempt. `zone` is `null` for the default attempt and a
   * `Zone` for each fallback. Should throw a `ScrapeError` on hard failures
   * (product_not_found, price_missing, ...) exactly like a normal scrape would.
   */
  attempt: (zone: Zone | null) => Promise<ScrapeResult>;
}

/** A result is "usable" only when it has a real, in-stock price. */
function isUsable(r: ScrapeResult): boolean {
  return r.inStock === true && Number.isFinite(r.price) && r.price > 0;
}

/**
 * Whether a default-zone error justifies sweeping other zones. Only "the
 * product/offer wasn't here" errors do; network/rate-limit/etc. are left to the
 * worker's normal retry policy and rethrown immediately.
 */
function isZoneRetryable(err: unknown): boolean {
  return (
    err instanceof ScrapeError &&
    (err.type === 'product_not_found' || err.type === 'price_missing')
  );
}

/**
 * Run a scrape with location fallback. See the file header for the policy.
 */
export async function runWithGeoFallback(
  params: GeoFallbackParams,
): Promise<ScrapeResult> {
  const { logger, config, attempt } = params;
  const geo = loadGeoRetryConfig(config);

  // --- 1. Default zone -----------------------------------------------------
  let defaultResult: ScrapeResult | undefined;
  let defaultError: unknown;
  try {
    defaultResult = await attempt(null);
    if (!geo.enabled || isUsable(defaultResult)) return defaultResult;
  } catch (err) {
    defaultError = err;
    // If geo-retry is off, or this isn't a "no offer here" error, the worker's
    // own retry policy should handle it — rethrow unchanged.
    if (!geo.enabled || !isZoneRetryable(err)) throw err;
  }

  // --- 2. Sweep other zones ------------------------------------------------
  const zones = geo.zones.slice(0, geo.maxZonesToTry);
  logger.info(
    {
      zones: zones.map((z) => z.id),
      reason: defaultError ? 'default_threw' : 'default_out_of_stock',
    },
    'geo-fallback: default zone has no in-stock price, sweeping zones',
  );

  for (const zone of zones) {
    try {
      const r = await attempt(zone);
      if (isUsable(r)) {
        r.zoneUsed = zone.id;
        logger.info(
          { zone: zone.id, price: r.price },
          'geo-fallback: found in-stock price in fallback zone',
        );
        return r;
      }
      logger.debug({ zone: zone.id }, 'geo-fallback: zone returned no in-stock price');
    } catch (err) {
      logger.debug(
        { zone: zone.id, err: (err as Error).message },
        'geo-fallback: zone attempt failed',
      );
    }
  }

  // --- 3. Nothing in stock anywhere ---------------------------------------
  if (defaultResult) {
    // The default zone had a price (just out of stock). Keep it so the price
    // history stays continuous rather than going blank.
    logger.info(
      { zonesTried: zones.length },
      'geo-fallback: no zone had stock, keeping default-zone result (out of stock)',
    );
    return defaultResult;
  }

  // Default threw product_not_found/price_missing AND no zone produced an
  // offer. This is genuinely unavailable everywhere we looked.
  throw new ScrapeError(
    'region_unavailable',
    `Product not available in the default zone or any of ${zones.length} ` +
      `fallback zones` +
      (defaultError instanceof Error ? ` (default error: ${defaultError.message})` : ''),
    defaultError !== undefined ? { cause: defaultError } : undefined,
  );
}
