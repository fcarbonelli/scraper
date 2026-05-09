/**
 * Pagination middleware.
 *
 * Parses `?page=` and `?limit=` from the request query, validates with zod,
 * and attaches `req.pagination = { page, limit, offset }`. Routes never have
 * to deal with query parsing for pagination directly.
 */

import type { NextFunction, Request, Response } from 'express';
import { PaginationQuery } from '../lib/parseQuery.js';
import { ApiError } from '../lib/apiError.js';

export function pagination(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const result = PaginationQuery.safeParse(req.query);
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
