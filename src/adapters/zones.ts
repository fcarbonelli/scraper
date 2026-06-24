/**
 * Shared geographic "zones" for location-aware retries.
 *
 * Several Argentine supermarkets regionalize availability and price by the
 * shopper's location (VTEX Regionalization, branch/sucursal selection, etc.).
 * When a product comes back missing / price-less / out-of-stock in the default
 * zone, adapters retry the scrape from other zones using this list.
 *
 * The list is intentionally small and spread across the country so we touch the
 * major chains' footprints (CABA, GBA, Córdoba, Rosario, Mendoza, Bahía Blanca,
 * etc.) without paying for dozens of lookups. Override per-supermarket via the
 * `supermarkets.config.zones` / `supermarkets.config.geoRetry` JSON blobs — no
 * code change or redeploy needed to tune coverage.
 */

/** One geographic zone we can re-scrape a product from. */
export interface Zone {
  /** Stable id used in logs and snapshots (e.g. "caba", "cordoba"). */
  id: string;
  /** Human-readable label for logs/forensics. */
  label: string;
  /** Province (for forensics). */
  provincia: string;
  /**
   * Argentine postal code (CP) used to resolve a region/seller. This is the
   * input VTEX's region endpoint expects and the most natural key for any
   * postal-code-driven storefront.
   */
  postalCode: string;
  /**
   * Optional site-specific identifier (e.g. a sucursal/branch id) for stores
   * that key location off something other than a postal code. Adapters read
   * this only if they have a confirmed per-site mechanism for it.
   */
  code?: string;
}

/**
 * Default AR zone list, ordered by population / chain coverage so the most
 * likely-to-stock zones are tried first (cheaper on average).
 */
export const DEFAULT_ZONES: Zone[] = [
  { id: 'caba', label: 'CABA', provincia: 'CABA', postalCode: '1414' },
  { id: 'gba-oeste', label: 'GBA Oeste (Morón)', provincia: 'BUENOS AIRES', postalCode: '1708' },
  { id: 'la-plata', label: 'La Plata', provincia: 'BUENOS AIRES', postalCode: '1900' },
  { id: 'cordoba', label: 'Córdoba Capital', provincia: 'CORDOBA', postalCode: '5000' },
  { id: 'rosario', label: 'Rosario', provincia: 'SANTA FE', postalCode: '2000' },
  { id: 'mendoza', label: 'Mendoza Capital', provincia: 'MENDOZA', postalCode: '5500' },
  { id: 'mar-del-plata', label: 'Mar del Plata', provincia: 'BUENOS AIRES', postalCode: '7600' },
  { id: 'bahia-blanca', label: 'Bahía Blanca', provincia: 'BUENOS AIRES', postalCode: '8000' },
  { id: 'tucuman', label: 'San Miguel de Tucumán', provincia: 'TUCUMAN', postalCode: '4000' },
  { id: 'neuquen', label: 'Neuquén Capital', provincia: 'NEUQUEN', postalCode: '8300' },
];

/** Effective geo-retry settings for one supermarket. */
export interface GeoRetryConfig {
  /** Whether geo-fallback is enabled for this supermarket. Default true. */
  enabled: boolean;
  /** Max non-default zones to try before giving up. Default = all DEFAULT_ZONES. */
  maxZonesToTry: number;
  /** The zone list to iterate (the default zone is implicit = no region). */
  zones: Zone[];
}

// Sweep the whole default zone list by default. The previous cap of 5 only
// reached the five most-populated zones (CABA, GBA-Oeste, La Plata, Córdoba,
// Rosario), so products stocked ONLY in the south/Patagonia (Mendoza, Mar del
// Plata, Bahía Blanca, Tucumán, Neuquén — zones 6-10) failed every day even
// though geo-fallback was "on". The sweep only runs for products that already
// failed the default zone, and region lookups are cached per (store, CP) for a
// day, so the extra cost is bounded. Narrow it per-store via config.geoRetry.
const DEFAULTS = { enabled: true, maxZonesToTry: DEFAULT_ZONES.length } as const;

/**
 * Build the effective geo-retry config for a supermarket, merging the code
 * defaults above with any `supermarkets.config.geoRetry` / `.zones` overrides.
 *
 * Shape expected in `supermarkets.config`:
 *   {
 *     "geoRetry": { "enabled": true, "maxZonesToTry": 5 },
 *     "zones": [{ "id": "cordoba", "postalCode": "5000", "label": "...", "code": "..." }]
 *   }
 */
export function loadGeoRetryConfig(
  config: Record<string, unknown> | undefined,
): GeoRetryConfig {
  const raw =
    config && typeof config['geoRetry'] === 'object' && config['geoRetry'] !== null
      ? (config['geoRetry'] as Record<string, unknown>)
      : {};

  const enabled = typeof raw['enabled'] === 'boolean' ? raw['enabled'] : DEFAULTS.enabled;
  const maxZonesToTry =
    typeof raw['maxZonesToTry'] === 'number' && raw['maxZonesToTry'] >= 0
      ? Math.floor(raw['maxZonesToTry'])
      : DEFAULTS.maxZonesToTry;
  const zones = parseZonesOverride(config?.['zones']) ?? DEFAULT_ZONES;

  return { enabled, maxZonesToTry, zones };
}

/** Validate + normalize a `config.zones` override; returns undefined if unusable. */
function parseZonesOverride(raw: unknown): Zone[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: Zone[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const o = entry as Record<string, unknown>;
    if (typeof o['id'] !== 'string' || typeof o['postalCode'] !== 'string') continue;
    const zone: Zone = {
      id: o['id'],
      label: typeof o['label'] === 'string' ? o['label'] : o['id'],
      provincia: typeof o['provincia'] === 'string' ? o['provincia'] : '',
      postalCode: o['postalCode'],
    };
    if (typeof o['code'] === 'string') zone.code = o['code'];
    out.push(zone);
  }
  return out.length > 0 ? out : undefined;
}
