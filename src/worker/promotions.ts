/**
 * Promotion flattening — turn the adapter `Promotion[]` into the discrete,
 * client-facing columns persisted on `price_snapshots`.
 *
 * Kept as a PURE module (no DB / env imports) so it can be unit-tested in
 * isolation and reused by validation tooling.
 *
 * IMPORTANT unit convention: `Promotion.discountPct` is a PERCENTAGE in the
 * range 0-100 (e.g. 15 means "15% off"), as emitted by every adapter
 * (Carrefour PercentualDiscount, Coto porcentaje, LCEC descuento_porcentaje).
 * The DB column `price_snapshots.unit_discount` is `numeric(5,4)` — i.e. a
 * FRACTION (max 9.9999). So we divide by 100 before storing, and clamp to the
 * column's range so a malformed teaser (e.g. "150%") can never overflow and
 * crash the whole snapshot insert.
 */

import type { Promotion } from '../adapters/types.js';

export interface FlatPromotions {
  promotion_1: string | null;
  promotion_2: string | null;
  offer_price_1: number | null;
  offer_price_2: number | null;
  /** Largest discount as a FRACTION (0-1), clamped to numeric(5,4) range. */
  unit_discount: number | null;
}

/**
 * Upper bound for `unit_discount`. Semantically a discount can't exceed 100%
 * (fraction 1.0), and 1.0000 fits numeric(5,4), so we clamp there. This is the
 * safety net that prevents the "numeric field overflow" (Postgres 22003) we hit
 * when a 15% teaser was stored as the literal 15.
 */
const MAX_UNIT_DISCOUNT_FRACTION = 1;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Convert an adapter discount percentage (0-100) into a fraction (0-1), clamped
 * to a sane range. Returns null for missing/zero/negative/NaN input.
 */
export function discountPctToFraction(
  pct: number | null | undefined,
): number | null {
  if (pct == null || !Number.isFinite(pct) || pct <= 0) return null;
  return Math.min(pct / 100, MAX_UNIT_DISCOUNT_FRACTION);
}

/**
 * Flatten the promotions array into the discrete columns the client expects.
 * Computes offer prices from discount percentages (or absolute amounts) when
 * available. All outputs are bounded so they always fit their DB columns.
 */
export function flattenPromotions(
  promotions: Promotion[] | undefined,
  regularPrice: number,
): FlatPromotions {
  const promos = promotions ?? [];
  const p1 = promos[0];
  const p2 = promos[1];

  const computeOfferPrice = (promo: Promotion | undefined): number | null => {
    if (!promo) return null;
    // discountPct is a percentage (0-100) -> convert to a fraction for math.
    if (promo.discountPct != null && promo.discountPct > 0) {
      const frac = Math.min(promo.discountPct / 100, 1);
      return Math.max(0, round2(regularPrice * (1 - frac)));
    }
    if (promo.discountAmount != null && promo.discountAmount > 0) {
      return Math.max(0, round2(regularPrice - promo.discountAmount));
    }
    return null;
  };

  // Unit discount = largest percentage discount across all promotions.
  let maxDiscountPct: number | null = null;
  for (const promo of promos) {
    if (promo.discountPct != null && promo.discountPct > 0) {
      if (maxDiscountPct === null || promo.discountPct > maxDiscountPct) {
        maxDiscountPct = promo.discountPct;
      }
    }
  }

  return {
    promotion_1: p1?.description ?? null,
    promotion_2: p2?.description ?? null,
    offer_price_1: computeOfferPrice(p1),
    offer_price_2: computeOfferPrice(p2),
    unit_discount: discountPctToFraction(maxDiscountPct),
  };
}
