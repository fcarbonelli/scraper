/**
 * The adapter contract.
 *
 * Every supermarket implements `SupermarketAdapter`. The worker is
 * site-agnostic — it just calls `adapter.scrape(ctx)` and writes the result.
 * Adding a new supermarket = writing one file in src/adapters/.
 */

import type { Logger } from '../shared/logger.js';

/** Tier/source used for the snapshot (for analytics + per-tier breakdown). */
export type Tier = 'api' | 'html' | 'ai' | 'manual';

/** Supermarket config row from the DB, passed to the adapter at scrape time. */
export interface SupermarketConfig {
  id: string;
  name: string;
  baseUrl: string | null;
  rateLimitMs: number;
  concurrency: number;
  /** Free-form per-adapter config (auth tokens, selector overrides, etc.) */
  config: Record<string, unknown>;
}

/** Everything an adapter needs to perform one scrape. */
export interface ScrapeContext {
  /** UUID of the supermarket_products row this scrape belongs to. */
  supermarketProductId: string;
  /** Supermarket's external SKU/id (e.g. "00591050-00591050-200" for Coto). */
  externalId: string;
  /** Canonical, user-facing URL (no scraping params). May be null. */
  externalUrl: string | null;
  /** Live config from the DB. */
  config: SupermarketConfig;
  /** Pre-scoped logger with supermarket+sku context attached. */
  logger: Logger;
  /** Abort signal — adapters should pass this through to fetch/playwright. */
  signal?: AbortSignal;
}

/** Normalized promotion shape, regardless of which supermarket detected it. */
export interface Promotion {
  type:
    | 'discount'           // generic % or $ discount
    | 'payment_method'     // discount when paying with X card/method
    | 'bundle'             // 2x1, 3x2, "compre N lleve M"
    | 'loyalty'            // discount for loyalty/community members
    | 'unknown';
  /** Human-readable description for the UI/alerts. */
  description: string;
  discountPct?: number;
  discountAmount?: number;
  /** E.g. ["galicia", "santander"] for payment-method offers. */
  validPaymentMethods?: string[];
  /** Original site-specific blob — kept for forensics/UI fidelity. */
  raw?: unknown;
}

/** Optional master-catalog data the adapter can extract. */
export interface ProductInfo {
  name?: string;
  brand?: string;
  category?: string;
  unit?: string;
  ean?: string;
  imageUrl?: string;
  /** Anything else that doesn't fit a strict column. */
  metadata?: Record<string, unknown>;
}

/** What the adapter returns on success. */
export interface ScrapeResult {
  price: number;
  /** Crossed-out / "before discount" price, if visible. */
  listPrice?: number;
  /** Per-unit price (e.g. per liter or per kg), if exposed. */
  unitPrice?: number;
  /** Unit label that `unitPrice` is per ("Litro", "Kg", "100g"). */
  unitPricePer?: string;
  inStock: boolean;
  currency: string;
  tierUsed: Tier;
  promotions?: Promotion[];
  /** Optional master-catalog info — used to backfill the products table. */
  productInfo?: ProductInfo;
  /** Full normalized response from the site, kept in raw_data for forensics. */
  rawData?: Record<string, unknown>;
}

export interface SupermarketAdapter {
  /** Stable id matching `supermarkets.id` in the DB ("coto", "carrefour"). */
  id: string;
  /** Human-readable name for logs and alerts. */
  name: string;
  /**
   * Convert any URL into the canonical, user-facing URL (no scraping params).
   * Used when ingesting URLs into the DB so we always store the clean form.
   */
  canonicalizeUrl?(url: string): string;
  /**
   * Derive the supermarket's stable `external_id` from a canonical product URL.
   *
   * Called once when a URL is first ingested into the DB (by scrape-url.ts).
   * The result is stored in `supermarket_products.external_id` and reused for
   * every subsequent scrape, so daily scrapes don't pay this cost.
   *
   * Two flavors:
   *   - Pure URL parsing (e.g. Coto extracts an id embedded in the path).
   *   - One extra HTTP call (e.g. Carrefour/VTEX needs a `pagetype` lookup
   *     to map slug -> productId).
   *
   * Adapters whose external_id is just the URL pathname can omit this method;
   * the script falls back to that.
   */
  resolveExternalId?(canonicalUrl: string, signal?: AbortSignal): Promise<string>;
  /** Perform a single scrape attempt for one product. */
  scrape(ctx: ScrapeContext): Promise<ScrapeResult>;
  /**
   * Lightweight probe — extract product metadata for ingest WITHOUT doing
   * anything heavy. Specifically: must NOT trigger interactive auth flows
   * (Playwright login, OAuth dance, etc.) because this runs synchronously
   * inside the API request and Caddy will 502 after ~30s.
   *
   * The returned `ProductInfo` is used to seed the master `products` table.
   * Price/stock are NOT needed here — the next scheduled scrape (running
   * in the worker, with a generous time budget) will capture those.
   *
   * If a site exposes everything publicly, this can just be `scrape()` minus
   * the price logic. If a site requires auth even for metadata, return `{}`
   * — the row will be inserted with placeholder info and backfilled later.
   *
   * Adapters that don't implement this fall back to `scrape()` in the
   * ingest layer (legacy behavior — slow for auth-gated sites).
   */
  probe?(ctx: ScrapeContext): Promise<ProductInfo>;
}
