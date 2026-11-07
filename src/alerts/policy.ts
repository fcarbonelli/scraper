/**
 * Incident policy: decides whether one supermarket's outcome in a run is
 * "really broken" (worth a Telegram ping) or just the usual daily noise.
 *
 * Pure — no DB, no env — so the rules are unit-tested in policy.test.ts.
 *
 * Every day some share of products is delisted, out of stock at that branch,
 * or missing a price (`product_not_found` / `price_missing`). For several
 * chains that share is permanently 30–80%, so absolute failure-rate bands page
 * every morning for nothing. Instead a chain is an incident only when:
 *
 *   - down:    almost nothing came back (success rate <= 10%)
 *   - blocked: a meaningful slice failed with an error class that never fixes
 *              itself (expired session, changed page, jobs that never ran) —
 *              or with a transient class that the automatic recovery retry
 *              already failed to fix
 *   - drop:    the success rate fell to under half of the chain's own recent
 *              median — catches regressions on chains whose normal is < 100%
 */

import type { Severity } from './notify.js';

/** Synthetic error type for planned products that never produced an outcome. */
export const NOT_RUN = 'not_run';

export type IncidentKind = 'down' | 'blocked' | 'drop';

/** Below this many failed products nothing is an incident (tiny chains). */
export const MIN_FAILED = 3;
export const DOWN_MAX_SUCCESS_RATE = 0.1;
/** Share of the chain's products that must hit an actionable error. */
export const BLOCKED_MIN_SHARE = 0.25;
export const DROP_RATIO = 0.5;
/** A chain whose usual success rate is below this has no meaningful "drop". */
export const DROP_MIN_BASELINE = 0.2;
export const BASELINE_RUNS = 7;
export const BASELINE_MIN_RUNS = 3;

/**
 * Error classes that a retry will never fix and that point at our side
 * (credentials, adapter, worker) rather than at the product.
 */
const ACTIONABLE_ERROR_TYPES: ReadonlySet<string> = new Set([
  'auth_required',
  'selector_failed',
  'parse_failed',
  NOT_RUN,
]);

/** Retry-worthy classes; actionable only once a recovery retry didn't fix them. */
const TRANSIENT_ERROR_TYPES: ReadonlySet<string> = new Set([
  'network_timeout',
  'network_error',
  'rate_limited',
  'site_server_error',
  'unknown',
]);

const HINTS: Record<string, string> = {
  auth_required: 'Sesión, cookie o token vencido (ver la tarjeta de la cadena en docs/CADENAS.md).',
  selector_failed: 'El sitio cambió su HTML/JSON: hay que mirar el adapter.',
  parse_failed: 'El sitio devuelve algo que el adapter no entiende: probablemente cambió.',
  [NOT_RUN]: 'Los jobs nunca terminaron: ¿worker caído o cola trabada?',
  rate_limited: 'El sitio nos está bloqueando (WAF/429), incluso después del reintento automático.',
  network_timeout: 'El sitio no responde, incluso después del reintento automático.',
  network_error: 'Error de red contra el sitio, incluso después del reintento automático.',
  site_server_error: 'El sitio devuelve 5xx, incluso después del reintento automático.',
  product_not_found: 'Casi todo da "no encontrado": ¿cambiaron las URLs o la sucursal?',
};

export interface IncidentInput {
  total: number;
  succeeded: number;
  failed: number;
  errorTypeCounts: ReadonlyMap<string, number>;
  /** Median success rate over the chain's recent runs; null when unknown. */
  baselineSuccessRate: number | null;
  /** True when evaluating a recovery run (transient errors survived a retry). */
  afterRecovery?: boolean;
}

export interface IncidentVerdict {
  kind: IncidentKind;
  severity: Severity;
  /** The error class that triggered/dominates the incident. */
  dominantError: string | null;
  /** One-line, operator-facing hint about the likely cause. */
  hint: string | null;
}

/** Decide whether a chain's run outcome is an incident. Null = healthy enough. */
export function classifyIncident(input: IncidentInput): IncidentVerdict | null {
  const { total, succeeded, failed } = input;
  if (total === 0 || failed < MIN_FAILED) return null;

  const successRate = succeeded / total;
  const dominant = dominantErrorType(input.errorTypeCounts);

  if (successRate <= DOWN_MAX_SUCCESS_RATE) {
    return verdict('down', 'critical', dominant);
  }

  const actionable = topActionableError(input.errorTypeCounts, input.afterRecovery ?? false);
  if (actionable && actionable.count >= MIN_FAILED && actionable.count / total >= BLOCKED_MIN_SHARE) {
    return verdict('blocked', 'critical', actionable.type);
  }

  const baseline = input.baselineSuccessRate;
  if (baseline !== null && baseline >= DROP_MIN_BASELINE && successRate < baseline * DROP_RATIO) {
    return verdict('drop', 'warning', dominant);
  }

  return null;
}

function verdict(kind: IncidentKind, severity: Severity, dominantError: string | null): IncidentVerdict {
  return { kind, severity, dominantError, hint: dominantError ? (HINTS[dominantError] ?? null) : null };
}

export function dominantErrorType(counts: ReadonlyMap<string, number>): string | null {
  let top: string | null = null;
  let topCount = 0;
  for (const [type, count] of counts) {
    if (count > topCount) {
      top = type;
      topCount = count;
    }
  }
  return top;
}

function topActionableError(
  counts: ReadonlyMap<string, number>,
  afterRecovery: boolean,
): { type: string; count: number } | null {
  let top: { type: string; count: number } | null = null;
  for (const [type, count] of counts) {
    const actionable =
      ACTIONABLE_ERROR_TYPES.has(type) || (afterRecovery && TRANSIENT_ERROR_TYPES.has(type));
    if (!actionable) continue;
    if (!top || count > top.count) top = { type, count };
  }
  return top;
}

/**
 * Median success rate of the most recent runs, or null when there are fewer
 * than BASELINE_MIN_RUNS data points (a new chain has no "normal" yet).
 * `rates` must be ordered newest first.
 */
export function baselineSuccessRate(rates: readonly number[]): number | null {
  const recent = rates.slice(0, BASELINE_RUNS);
  if (recent.length < BASELINE_MIN_RUNS) return null;
  const sorted = [...recent].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** "auth_required (12), product_not_found (4)" — biggest first. */
export function topErrorsSummary(counts: ReadonlyMap<string, number>, take = 3): string {
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, take)
    .map(([type, count]) => `${type} (${count})`)
    .join(', ');
}
