/**
 * Consistent response envelopes used by every API route.
 *
 *   Success:       { data: T,     meta: { ts } }
 *   Paginated:     { data: T[],   pagination: {...}, meta: { ts } }
 *   Error:         { error: { code, message, details? } }
 *
 * Routes use the helpers here so the shape is uniform across endpoints,
 * which keeps the future frontend dead simple.
 */

export interface ResponseMeta {
  ts: string;          // ISO timestamp; useful for client cache busting
}

export interface SuccessEnvelope<T> {
  data: T;
  meta: ResponseMeta;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface PaginatedEnvelope<T> {
  data: T[];
  pagination: Pagination;
  meta: ResponseMeta;
}

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export function success<T>(data: T): SuccessEnvelope<T> {
  return { data, meta: { ts: new Date().toISOString() } };
}

export function paginated<T>(
  data: T[],
  total: number,
  page: number,
  limit: number,
): PaginatedEnvelope<T> {
  return {
    data,
    pagination: {
      page,
      limit,
      total,
      totalPages: limit > 0 ? Math.max(1, Math.ceil(total / limit)) : 1,
    },
    meta: { ts: new Date().toISOString() },
  };
}

export function failure(
  code: string,
  message: string,
  details?: unknown,
): ErrorEnvelope {
  const out: ErrorEnvelope = { error: { code, message } };
  if (details !== undefined) out.error.details = details;
  return out;
}
