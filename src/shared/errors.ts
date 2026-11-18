/**
 * Domain-specific error types for the scraping pipeline.
 *
 * Throw these from adapters so the worker can classify failures and pick the
 * right retry policy. Generic Error/TypeError still work — they fall through
 * to "unknown" classification.
 */

/** Discriminated error categories the engine knows about. */
export type ErrorType =
  | 'network_timeout'
  | 'network_error'
  | 'rate_limited'
  | 'product_not_found'
  | 'region_unavailable'
  | 'site_server_error'
  | 'auth_required'
  | 'selector_failed'
  | 'parse_failed'
  | 'price_missing'
  | 'unknown';

/**
 * Base class. Adapters throw subclasses of this. The worker reads `.type`
 * to decide retry behavior and what alert to create.
 */
export class ScrapeError extends Error {
  readonly type: ErrorType;
  readonly httpStatus?: number;
  readonly retryable: boolean;

  constructor(
    type: ErrorType,
    message: string,
    options?: { httpStatus?: number; retryable?: boolean; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ScrapeError';
    this.type = type;
    if (options?.httpStatus !== undefined) this.httpStatus = options.httpStatus;
    // Default retryability based on type — can be overridden
    this.retryable =
      options?.retryable ?? defaultRetryable(type);
  }
}

/**
 * Build a human-readable detail string for a network/fetch failure.
 *
 * undici surfaces connection failures as a generic `TypeError: fetch failed`
 * and stashes the real reason on `.cause` (e.g. ECONNRESET,
 * UND_ERR_CONNECT_TIMEOUT). When every connect attempt fails (happy-eyeballs or
 * a dead proxy exit IP), `.cause` is an `AggregateError` whose own
 * `.code`/`.message` are empty — so we drill into its `.errors[]` to recover
 * the underlying code. Without this, proxy failures log as a bare "fetch
 * failed" that can't tell a transient blip apart from an exhausted/blocked
 * proxy.
 */
export function describeNetworkError(err: unknown): string {
  const top = err as { message?: string; cause?: unknown };
  const base = top.message ?? 'fetch failed';
  const detail = extractErrDetail(top.cause);
  return detail ? `${base} (${detail})` : base;
}

function extractErrDetail(e: unknown): string | undefined {
  if (!e || typeof e !== 'object') return undefined;
  const o = e as { code?: string; message?: string; errors?: unknown[] };
  if (o.code) return o.code;
  // AggregateError: every connect attempt failed; use the first child's detail.
  if (Array.isArray(o.errors) && o.errors.length > 0) {
    const child = extractErrDetail(o.errors[0]);
    if (child) return child;
  }
  return o.message || undefined;
}

function defaultRetryable(type: ErrorType): boolean {
  switch (type) {
    case 'network_timeout':
    case 'network_error':
    case 'rate_limited':
    case 'site_server_error':
    case 'parse_failed':
    case 'unknown':
      return true;
    case 'product_not_found':
    case 'region_unavailable':
    case 'selector_failed':
    case 'auth_required':
    case 'price_missing':
      return false;
  }
}
