/**
 * Pagination middleware.
 *
 * Parses `?page=` and `?limit=` from the request query, validates with zod,
 * and attaches `req.pagination = { page, limit, offset }`. Routes never have
 * to deal with query parsing for pagination directly.
 */

import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../lib/apiError.js';

/**
 * Outer pagination ceiling for the generic pre-parse step.
 *
 * This middleware runs on EVERY `/v1` route, so its `limit` ceiling must be at
 * least the highest per-route maximum — otherwise it rejects valid requests
 * before they reach the route. `/v1/data/pricing` documents (and validates) a
 * limit up to 1000, so the ceiling here is 1000.
 *
 * This is intentionally NOT the shared `PaginationQuery` (max 200): each route
 * still enforces its own stricter `limit` via its own zod schema, which runs
 * before it reads `req.pagination`. So general endpoints keep their documented
 * 200 cap while the pricing endpoint gets its full 1000.
 */
const MiddlewarePaginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(1000).default(50),
});

export function pagination(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const result = MiddlewarePaginationQuery.safeParse(req.query);
  if (!result.success) {
    return next(
      ApiError.badRequest(
        'Invalid pagination',
        result.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      ),
    );
  }
  const { page, limit } = result.data;
  req.pagination = { page, limit, offset: (page - 1) * limit };
  next();
}
