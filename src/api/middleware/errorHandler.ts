/**
 * Centralized Express error handler.
 *
 * - `ApiError` -> respond with its statusCode and the consistent `error`
 *   envelope (code, message, details).
 * - Anything else -> log full details, return 500 with a generic message
 *   (so we never leak stack traces or DB error text to API consumers).
 *
 * Express identifies error handlers by their 4-arg signature; do NOT remove
 * the `_next` parameter even though we don't call it.
 */

import type { ErrorRequestHandler } from 'express';
import { logger } from '../../shared/logger.js';
import { captureError } from '../../shared/sentry.js';
import { ApiError } from '../lib/apiError.js';
import { failure } from '../lib/envelope.js';
import { CLIENT_PRICING_PATH, clientPricingError } from '../lib/clientPricing.js';

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  // The external client pricing endpoint must always answer with its own
  // envelope ({ ProcesadoOk: false, Error, ... }) — even on auth or unexpected
  // errors — so the integration never sees our internal error shape.
  // Use originalUrl (never rewritten by nested routers) and drop the query string.
  const pathOnly = req.originalUrl.split('?')[0];
  const isClientPricing = pathOnly === CLIENT_PRICING_PATH;

  if (err instanceof ApiError) {
    // Expected client-facing error — info-level log is enough.
    logger.info(
      {
        path: req.path,
        method: req.method,
        code: err.code,
        statusCode: err.statusCode,
      },
      'api error response',
    );
    if (isClientPricing) {
      res.status(err.statusCode).json(clientPricingError(err.message));
      return;
    }
    res.status(err.statusCode).json(failure(err.code, err.message, err.details));
    return;
  }

  // Body-parser / http-errors style client errors: malformed JSON, payload too
  // large, unsupported charset, etc. express.json() throws these with a numeric
  // `status` and `expose: true`. Without this branch they fall through to the
  // generic 500 below — masking a client mistake (e.g. mangled body) as a
  // server fault, which is exactly the opaque 500 we hit debugging ingest.
  const httpErr = err as {
    status?: number;
    statusCode?: number;
    type?: string;
    expose?: boolean;
  };
  const bodyStatus = httpErr.status ?? httpErr.statusCode;
  if (
    typeof bodyStatus === 'number' &&
    bodyStatus >= 400 &&
    bodyStatus < 500 &&
    httpErr.expose === true
  ) {
    const { code, message } = classifyBodyError(httpErr.type, bodyStatus);
    logger.info(
      { path: req.path, method: req.method, code, statusCode: bodyStatus, type: httpErr.type },
      'api client error (body parser)',
    );
    if (isClientPricing) {
      res.status(bodyStatus).json(clientPricingError(message));
      return;
    }
    res.status(bodyStatus).json(failure(code, message));
    return;
  }

  // Unexpected error — log everything, send generic 500.
  logger.error(
    { err, path: req.path, method: req.method },
    'unhandled error in API handler',
  );
  captureError(err, { path: req.path, method: req.method });

  if (isClientPricing) {
    res
      .status(500)
      .json(clientPricingError('Error interno al procesar la solicitud.'));
    return;
  }

  res.status(500).json(
    failure('INTERNAL', 'Internal server error'),
  );
};

/**
 * Map an express.json / body-parser error to a stable envelope code + a safe,
 * client-facing message (never leak the raw parser text). Falls back sensibly
 * for any 4xx body-parser type we don't special-case.
 */
function classifyBodyError(
  type: string | undefined,
  status: number,
): { code: string; message: string } {
  switch (type) {
    case 'entity.parse.failed':
      return { code: 'INVALID_REQUEST', message: 'Request body is not valid JSON' };
    case 'entity.too.large':
      return { code: 'PAYLOAD_TOO_LARGE', message: 'Request body exceeds the size limit' };
    case 'charset.unsupported':
    case 'encoding.unsupported':
      return { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Unsupported request encoding' };
    default:
      return {
        code: status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_REQUEST',
        message: 'Malformed request',
      };
  }
}

/** 404 catch-all for unmatched routes. Mount AFTER all real routes. */
export const notFoundHandler: import('express').RequestHandler = (req, _res, next) => {
  next(new ApiError('NOT_FOUND', `Route ${req.method} ${req.path} not found`));
};
