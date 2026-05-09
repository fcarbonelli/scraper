/**
 * Shared types for the API layer.
 *
 * Includes module augmentation that attaches `req.apiKey` and `req.pagination`
 * so middleware can populate them and routes can read them safely.
 */

import 'express';
import type { PaginationQuery } from './lib/parseQuery.js';

declare module 'express-serve-static-core' {
  interface Request {
    /** Populated by `auth` middleware after successful key validation. */
    apiKey?: { id: string; name: string };
    /** Populated by `pagination` middleware. */
    pagination?: PaginationQuery & { offset: number };
  }
}

export {};
