/**
 * Contracts for the bank/card promotions module.
 *
 * This mirrors the adapter/registry split of the supermarket engine, but for a
 * different axis of data: payment-method promotions published by banks / card
 * issuers (Naranja X first). A "provider" is the analog of a supermarket
 * adapter — one file per source, registered in `registry.ts`.
 *
 * The engine (pipeline/store) is provider-agnostic: it calls
 * `provider.fetchAll(ctx)` and persists the returned `NormalizedPromotion[]`.
 */

import type { Logger } from '../shared/logger.js';

/** Everything a provider needs to run one fetch. Kept tiny + serializable. */
export interface PromoContext {
  logger: Logger;
  /** DB-driven per-provider config (promo_providers.config): tokens, toggles… */
  config: Record<string, unknown>;
  /** Cooperative cancellation for long/hung network calls. */
  signal?: AbortSignal;
}

/**
 * One individual promo "plan" inside a promotion (a promotion can bundle
 * several: e.g. "25% off" + "12 cuotas cero interés"). Stored losslessly as
 * jsonb; the shape is intentionally loose across providers.
 */
export interface PromotionPlan {
  title: string;                    // "12 cuotas cero interés" / "25% off"
  paymentMethods: string[];         // normalized keys (CREDITO, DEBITO, …)
  weekdays: string[];               // MONDAY..SUNDAY or ['ALL_DAYS']
  validFrom: string | null;         // ISO
  validTo: string | null;           // ISO
  appliesOnline: boolean | null;
  discountPct: number | null;       // parsed from title when present
  installments: number | null;      // parsed from title when present
  raw?: Record<string, unknown>;
}

/**
 * The shape every provider normalizes into. One row per promotion in the
 * `promotions` table (de-duplicated by providerId + externalId).
 */
export interface NormalizedPromotion {
  providerId: string;
  externalId: string;               // stable source id (e.g. Naranja X binder id)

  title: string | null;             // headline for the card
  /**
   * Issuing bank / card entity behind the promo ("Galicia", "Credicoop",
   * "MODO" for cross-bank, "Naranja X"). The key filter dimension for
   * multi-bank aggregators (MODO). Defaults to the provider name.
   */
  issuer: string | null;
  merchant: string | null;          // "Disco"
  category: string | null;          // taxonomy key, e.g. "SUPERMERCADOS"
  categoryName: string | null;      // "Supermercados"
  subcategory: string | null;       // "HIPERMERCADOS"
  subtitle: string | null;

  paymentMethods: string[];         // union across plans, normalized keys
  weekdays: string[];               // union across plans (MONDAY..SUNDAY / ALL_DAYS)
  purchaseModes: string[];          // ONLINE / IN_STORE

  maxDiscountPct: number | null;    // convenience, derived from plans
  maxInstallments: number | null;   // convenience, derived from plans

  validFrom: string | null;         // ISO — earliest plan start
  validTo: string | null;           // ISO — latest plan end

  url: string | null;               // commerce slug
  fullUrl: string | null;           // canonical promo page URL
  logoUrl: string | null;
  imageUrl: string | null;

  isFeatured: boolean;              // appears in the homepage carousel

  plans: PromotionPlan[];
  tags: unknown[];                  // provider tags (accreditation/refund/…)
  raw: Record<string, unknown>;     // original payload
}

/** One provider (bank/issuer). Analog of a supermarket adapter. */
export interface PromoProvider {
  id: string;                       // 'naranjax'
  name: string;                     // 'Naranja X'
  /** Discover + fetch every current promotion, normalized. */
  fetchAll(ctx: PromoContext): Promise<NormalizedPromotion[]>;
}

/** Per-provider outcome of a run (for logs / summary). */
export interface ProviderRunSummary {
  providerId: string;
  fetched: number;
  upserted: number;
  created: number;
  /** How many promotions were NEW or CHANGED this run (i.e. got a snapshot). */
  snapshotted: number;
  /** How many were unchanged (upserted in place, no snapshot written). */
  unchanged: number;
  deactivated: number;
  error?: string;
}
