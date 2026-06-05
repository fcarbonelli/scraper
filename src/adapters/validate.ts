/**
 * Result invariants checker — the single source of truth for "is this scrape
 * result sane enough to persist?".
 *
 * This is intentionally a PURE module (no DB / env imports) so it can be reused
 * by:
 *   - the smoke-test harness (scripts/smoke-test.ts) to flag bad adapters,
 *   - unit tests,
 *   - and, if desired, the worker before writing.
 *
 * The bounds mirror the DB column constraints in
 * `migrations/001_initial_schema.sql` / `002_*.sql` so we catch a value that
 * would be rejected by Postgres (e.g. the numeric overflow that took out every
 * Carrefour product) BEFORE it ever reaches the database.
 */

import type { ScrapeResult } from './types.js';

/** numeric(12,2): max absolute value is 9_999_999_999.99 */
const MAX_NUMERIC_12_2 = 9_999_999_999.99;

export interface ValidationResult {
  ok: boolean;
  /** Hard problems that would break persistence or are clearly wrong. */
  errors: string[];
  /** Soft problems worth a look but that won't break the insert. */
  warnings: string[];
}

/**
 * Validate a ScrapeResult against business rules + DB column constraints.
 * Returns structured errors/warnings; never throws.
 */
export function validateScrapeResult(r: ScrapeResult): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // --- price (NOT NULL, numeric(12,2)) ---
  if (typeof r.price !== 'number' || !Number.isFinite(r.price)) {
    errors.push(`price is not a finite number (got ${String(r.price)})`);
  } else {
    if (r.price <= 0) errors.push(`price must be > 0 (got ${r.price})`);
    if (Math.abs(r.price) > MAX_NUMERIC_12_2) {
      errors.push(`price exceeds numeric(12,2) range (got ${r.price})`);
    }
  }

  // --- in_stock / currency (required columns) ---
  if (typeof r.inStock !== 'boolean') {
    errors.push(`inStock must be a boolean (got ${typeof r.inStock})`);
  }
  if (!r.currency || typeof r.currency !== 'string') {
    errors.push('currency is missing');
  }

  // --- optional numerics that share the numeric(12,2) constraint ---
  for (const [name, val] of [
    ['listPrice', r.listPrice],
    ['unitPrice', r.unitPrice],
  ] as const) {
    if (val == null) continue;
    if (!Number.isFinite(val)) {
      errors.push(`${name} is not finite (got ${String(val)})`);
    } else if (Math.abs(val) > MAX_NUMERIC_12_2) {
      errors.push(`${name} exceeds numeric(12,2) range (got ${val})`);
    } else if (val < 0) {
      errors.push(`${name} must be >= 0 (got ${val})`);
    }
  }

  // --- list price sanity: the crossed-out price should be >= sale price ---
  if (
    r.listPrice != null &&
    Number.isFinite(r.listPrice) &&
    Number.isFinite(r.price) &&
    r.listPrice < r.price
  ) {
    warnings.push(
      `listPrice (${r.listPrice}) is lower than price (${r.price})`,
    );
  }

  // --- promotions: discountPct must be a percentage (0-100) ---
  for (const [i, p] of (r.promotions ?? []).entries()) {
    if (p.discountPct != null) {
      if (!Number.isFinite(p.discountPct)) {
        errors.push(`promotions[${i}].discountPct is not finite`);
      } else if (p.discountPct < 0 || p.discountPct > 100) {
        // > 100 is the smell that caused the unit_discount overflow.
        errors.push(
          `promotions[${i}].discountPct out of 0-100 range (got ${p.discountPct}) ` +
            `— adapters must emit a PERCENTAGE, not a fraction`,
        );
      }
    }
    if (p.discountAmount != null && !Number.isFinite(p.discountAmount)) {
      errors.push(`promotions[${i}].discountAmount is not finite`);
    }
  }

  // --- soft signal: in stock but no price is suspicious ---
  if (r.inStock === true && (r.price == null || r.price <= 0)) {
    warnings.push('marked in stock but has no positive price');
  }

  return { ok: errors.length === 0, errors, warnings };
}
