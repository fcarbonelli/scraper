/**
 * Helpers for parsing & validating Express `req.query` with zod schemas.
 *
 * Pattern:
 *   const Q = z.object({ from: z.iso.date().optional(), ... });
 *   router.get('/', (req, res) => {
 *     const q = parseQuery(req, Q);
 *     ...
 *   });
 *
 * Throws `ApiError` with code INVALID_REQUEST on bad input — the error
 * handler middleware turns that into a 400 with field-level details.
 */

import type { Request } from 'express';
import { z } from 'zod';
import { ApiError } from './apiError.js';

export function parseQuery<T extends z.ZodTypeAny>(
  req: Request,
  schema: T,
): z.infer<T> {
  const result = schema.safeParse(req.query);
  if (!result.success) {
    throw ApiError.badRequest(
      'Invalid query parameters',
      result.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
        code: i.code,
      })),
    );
  }
  return result.data;
}

export function parseBody<T extends z.ZodTypeAny>(
  req: Request,
  schema: T,
): z.infer<T> {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    throw ApiError.badRequest(
      'Invalid request body',
      result.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
        code: i.code,
      })),
    );
  }
  return result.data;
}

/** Common pagination query — opt in via `Q.merge(PaginationQuery)`. */
export const PaginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type PaginationQuery = z.infer<typeof PaginationQuery>;
