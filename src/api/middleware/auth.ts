/**
 * X-API-Key authentication.
 *
 * Strategy:
 *   - SHA-256 hash the incoming key, look up in the `api_keys` table by hash.
 *     SHA-256 is fine here (vs bcrypt) because we generate the keys ourselves
 *     with high entropy (256 random bits) — there's nothing to brute-force.
 *   - In-memory LRU cache with 60s TTL avoids hitting the DB on every request.
 *   - We update `last_used_at` opportunistically (best-effort, no await).
 *
 * Apply this middleware to every route that should require auth. Public
 * routes (e.g., /health) are mounted before this middleware in server.ts.
 */

import { createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { db } from '../../shared/db.js';
import { logger } from '../../shared/logger.js';
import { ApiError } from '../lib/apiError.js';

interface CachedKey {
  id: string;
  name: string;
  isActive: boolean;
  /** Route scopes. null/empty = full access; otherwise restricted (see enforceScopes). */
  scopes: string[] | null;
  cachedAt: number;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, CachedKey>();

/**
 * Maps a key scope to the URL prefix it's allowed to reach. A scoped key is
 * rejected on any path outside its allowed prefix(es); an unscoped key (full
 * access) is unaffected. Keep this in sync when adding new scoped route groups.
 */
const SCOPE_PREFIXES: Record<string, string> = {
  'in-store': '/v1/in-store',
};

function hashKey(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

async function lookupKey(keyHash: string): Promise<CachedKey | null> {
  const { data, error } = await db
    .from('api_keys')
    .select('id, name, is_active, scopes')
    .eq('key_hash', keyHash)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const rawScopes = data.scopes as string[] | null;
  return {
    id: data.id as string,
    name: data.name as string,
    isActive: data.is_active as boolean,
    scopes: rawScopes && rawScopes.length > 0 ? rawScopes : null,
    cachedAt: Date.now(),
  };
}

function fromCache(keyHash: string): CachedKey | null {
  const entry = cache.get(keyHash);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    cache.delete(keyHash);
    return null;
  }
  return entry;
}

/** Express middleware: rejects request unless a valid X-API-Key is present. */
export async function requireApiKey(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const headerValue = req.header('X-API-Key') ?? req.header('x-api-key');
    if (!headerValue) {
      throw ApiError.unauthorized('Missing X-API-Key header');
    }
    const keyHash = hashKey(headerValue);

    let entry = fromCache(keyHash);
    if (!entry) {
      const fetched = await lookupKey(keyHash);
      if (!fetched) throw ApiError.unauthorized('Invalid API key');
      cache.set(keyHash, fetched);
      entry = fetched;
    }

    if (!entry.isActive) {
      throw ApiError.unauthorized('API key is disabled');
    }

    req.apiKey = { id: entry.id, name: entry.name, scopes: entry.scopes };

    // Best-effort last_used_at update — don't block the request on it.
    void db
      .from('api_keys')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', entry.id)
      .then(({ error }) => {
        if (error) logger.warn({ err: error, keyId: entry?.id }, 'failed to update last_used_at');
      });

    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Route-scope guard. Mount right after {@link requireApiKey} on `/v1`.
 *
 * Full-access keys (`scopes` null/empty) pass through untouched. A scoped key
 * may only reach paths under a prefix mapped to one of its scopes — every other
 * `/v1` route returns 403. This lets us embed a narrowly-scoped key in the
 * public in-store mobile app: if it leaks, it can only submit in-store prices,
 * never touch the rest of the API.
 */
export function enforceScopes(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const scopes = req.apiKey?.scopes;
  if (!scopes || scopes.length === 0) {
    next();
    return;
  }
  const path = req.originalUrl.split('?')[0] ?? '';
  const allowed = scopes.some((scope) => {
    const prefix = SCOPE_PREFIXES[scope];
    return prefix != null && path.startsWith(prefix);
  });
  if (!allowed) {
    next(
      new ApiError(
        'FORBIDDEN',
        'This API key is not allowed to access this endpoint',
      ),
    );
    return;
  }
  next();
}

/** Exposed for the create-api-key script so it uses the same hash function. */
export { hashKey };
/** Exposed so scripts/tooling can validate a requested scope name. */
export { SCOPE_PREFIXES };
