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
  cachedAt: number;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, CachedKey>();

function hashKey(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

async function lookupKey(keyHash: string): Promise<CachedKey | null> {
  const { data, error } = await db
    .from('api_keys')
    .select('id, name, is_active')
    .eq('key_hash', keyHash)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    id: data.id as string,
    name: data.name as string,
    isActive: data.is_active as boolean,
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

    req.apiKey = { id: entry.id, name: entry.name };

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

/** Exposed for the create-api-key script so it uses the same hash function. */
export { hashKey };
