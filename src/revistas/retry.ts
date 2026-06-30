/**
 * Retries with exponential backoff + jitter for transient calls (network / AI
 * APIs). Retries only what's worth retrying: network errors (no `status`) and
 * HTTP 429/5xx. Real 4xx (400/401/404) are NOT retried — they're deterministic.
 */

import { logger } from '../shared/logger.js';

export interface RetryOptions {
  retries?: number;
  baseMs?: number;
  label?: string;
}

function statusOf(err: unknown): number | undefined {
  return (err as { status?: number })?.status;
}

function isRetriable(err: unknown): boolean {
  const status = statusOf(err);
  if (status === undefined) return true; // no status → network/timeout → retriable
  return status === 429 || status >= 500;
}

/** Respect a Retry-After header (429) when present; else exponential backoff. */
function waitMsFor(err: unknown, attempt: number, baseMs: number): number {
  const retryAfter = (
    err as { headers?: { get?: (k: string) => string | null } }
  )?.headers?.get?.('retry-after');
  const seconds = retryAfter ? Number(retryAfter) : NaN;
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  return baseMs * 2 ** attempt + Math.floor(Math.random() * baseMs);
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const retries = opts.retries ?? 4;
  const baseMs = opts.baseMs ?? 500;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !isRetriable(err)) throw err;
      const waitMs = waitMsFor(err, attempt, baseMs);
      logger.warn(
        { label: opts.label, attempt: attempt + 1, retries, waitMs: Math.round(waitMs) },
        'revista: transient failure, retrying',
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

/**
 * `fetch` with retries on network errors and 429/5xx. Any other response
 * (incl. 404/403) is returned as-is so callers can handle it (e.g. the Publuu
 * page loop stops on the first 404). Does not change the `fetch` contract.
 */
export async function fetchRetry(
  url: string | URL,
  init?: RequestInit,
  label?: string,
): Promise<Response> {
  return withRetry(
    async () => {
      const res = await fetch(url, init);
      if (res.status === 429 || res.status >= 500) {
        throw Object.assign(new Error(`HTTP ${res.status} at ${label ?? String(url)}`), {
          status: res.status,
          headers: res.headers,
        });
      }
      return res;
    },
    { label: label ?? String(url) },
  );
}
