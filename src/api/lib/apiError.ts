/**
 * Error type the API layer throws to communicate HTTP-shaped failures.
 *
 * The error handler middleware unwraps these into the response envelope.
 * Anything else thrown (TypeError, DB error, etc.) is treated as 500.
 */

export type ApiErrorCode =
  | 'INVALID_REQUEST'   // 400 — bad query/body
  | 'UNAUTHORIZED'      // 401 — missing/invalid API key
  | 'FORBIDDEN'         // 403 — valid key, not allowed
  | 'NOT_FOUND'         // 404 — resource doesn't exist
  | 'CONFLICT'          // 409 — state conflict (e.g., already resolved)
  | 'RATE_LIMITED'      // 429 — too many requests
  | 'INTERNAL';         // 500 — unexpected error (rarely thrown directly)

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  INVALID_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.statusCode = STATUS_BY_CODE[code];
    if (details !== undefined) this.details = details;
  }

  // Convenience factories — keep call sites readable.
  static badRequest(message: string, details?: unknown): ApiError {
    return new ApiError('INVALID_REQUEST', message, details);
  }
  static unauthorized(message = 'Missing or invalid API key'): ApiError {
    return new ApiError('UNAUTHORIZED', message);
  }
  static forbidden(message = 'Not allowed'): ApiError {
    return new ApiError('FORBIDDEN', message);
  }
  static notFound(resource: string): ApiError {
    return new ApiError('NOT_FOUND', `${resource} not found`);
  }
  static conflict(message: string, details?: unknown): ApiError {
    return new ApiError('CONFLICT', message, details);
  }
}
