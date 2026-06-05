/**
 * Retry policy: how many times and how long to wait between attempts,
 * keyed by error type.
 *
 * The engine — not BullMQ — owns retries, so we can apply a different
 * backoff for "rate limited" (long wait) vs "timeout" (quick retry) vs
 * "selector broken" (don't retry, just alert).
 */

import type { ErrorType } from '../shared/errors.js';

export interface RetryRule {
  /** Maximum total attempts INCLUDING the initial one. 1 = no retry. */
  maxAttempts: number;
  /** Wait before each retry, in ms. */
  delayMs: number;
}

const POLICY: Record<ErrorType, RetryRule> = {
  network_timeout:    { maxAttempts: 3, delayMs: 60_000 },         // 1 min
  network_error:      { maxAttempts: 3, delayMs: 60_000 },         // 1 min
  rate_limited:       { maxAttempts: 3, delayMs: 30 * 60_000 },    // 30 min
  site_server_error:  { maxAttempts: 3, delayMs: 10 * 60_000 },    // 10 min
  parse_failed:       { maxAttempts: 2, delayMs: 60_000 },         // could be transient HTML/JSON glitch
  selector_failed:    { maxAttempts: 1, delayMs: 0 },              // don't retry — alert immediately
  price_missing:      { maxAttempts: 1, delayMs: 0 },              // don't retry — alert immediately
  product_not_found:  { maxAttempts: 1, delayMs: 0 },              // don't retry — product likely deleted
  region_unavailable: { maxAttempts: 1, delayMs: 0 },              // don't retry — adapter already swept all zones
  auth_required:      { maxAttempts: 1, delayMs: 0 },              // don't retry — needs human intervention
  unknown:            { maxAttempts: 3, delayMs: 10 * 60_000 },    // 10 min, give it the benefit of the doubt
};

export function getRetryRule(type: ErrorType): RetryRule {
  return POLICY[type];
}

export interface RetryDecision {
  shouldRetry: boolean;
  /** Delay (ms) to apply before the next attempt. 0 if not retrying. */
  delayMs: number;
  /** The next attempt number that would be processed. */
  nextAttempt: number;
}

/**
 * Decide whether the engine should requeue the job after this attempt.
 *
 * @param errorType   The classified error from the failed attempt.
 * @param attempt     Which attempt just failed (1-indexed).
 * @param retryable   Override: if false, never retry regardless of policy.
 */
export function decideRetry(
  errorType: ErrorType,
  attempt: number,
  retryable: boolean,
): RetryDecision {
  if (!retryable) return { shouldRetry: false, delayMs: 0, nextAttempt: attempt };
  const rule = getRetryRule(errorType);
  if (attempt >= rule.maxAttempts) {
    return { shouldRetry: false, delayMs: 0, nextAttempt: attempt };
  }
  return { shouldRetry: true, delayMs: rule.delayMs, nextAttempt: attempt + 1 };
}
