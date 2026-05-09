/**
 * Classifies any thrown error into one of our `ErrorType` categories.
 *
 * Adapters should already throw `ScrapeError` with the right type, but this
 * defends against unexpected errors (e.g. raw `fetch` failures bubbling up,
 * unhandled DB errors) by mapping common shapes to sensible categories.
 */

import { ScrapeError, type ErrorType } from '../shared/errors.js';

export interface ClassifiedError {
  type: ErrorType;
  message: string;
  stack?: string;
  httpStatus?: number;
  /** Whether the engine should attempt to retry this error. */
  retryable: boolean;
}

export function classifyError(err: unknown): ClassifiedError {
  if (err instanceof ScrapeError) {
    const result: ClassifiedError = {
      type: err.type,
      message: err.message,
      retryable: err.retryable,
    };
    if (err.stack !== undefined) result.stack = err.stack;
    if (err.httpStatus !== undefined) result.httpStatus = err.httpStatus;
    return result;
  }

  if (err instanceof Error) {
    const result: ClassifiedError = {
      type: classifyByShape(err),
      message: err.message,
      retryable: true,
    };
    if (err.stack !== undefined) result.stack = err.stack;
    return result;
  }

  return {
    type: 'unknown',
    message: typeof err === 'string' ? err : JSON.stringify(err),
    retryable: true,
  };
}

function classifyByShape(err: Error): ErrorType {
  const code = (err as Error & { code?: string }).code;
  if (err.name === 'AbortError' || code === 'ETIMEDOUT') return 'network_timeout';
  if (code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ENOTFOUND') {
    return 'network_error';
  }
  if (err.name === 'SyntaxError') return 'parse_failed';
  return 'unknown';
}
