/**
 * Supabase client (server-side, service role).
 *
 * Uses the SERVICE_ROLE key, which bypasses Row-Level Security. This is
 * intentional and SAFE only because this client never runs in the browser —
 * it's only used by orchestrator/worker/api server processes.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from './env.js';

if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    'Supabase env vars missing. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY ' +
      'in your .env file before importing src/shared/db.ts.',
  );
}

export const db: SupabaseClient = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      // Server-side only — no session persistence
      autoRefreshToken: false,
      persistSession: false,
    },
  },
);

/**
 * PostgREST serializes a `.in(col, ids)` filter into the request URL, so a
 * single filter with many ids (hundreds+) exceeds the server's URL length
 * limit and fails with HTTP 400 "Bad Request". Keep each chunk small enough
 * that the generated URL stays well under that limit.
 */
export const PG_IN_CHUNK_SIZE = 200;

/**
 * PostgREST caps a single response at 1000 rows by default; reads spanning more
 * rows must be paged. Used as the page size for {@link fetchAllPages}.
 */
export const PG_PAGE_SIZE = 1000;

type QueryResult<T> = PromiseLike<{ data: T[] | null; error: unknown }>;

/**
 * Run a `.in(col, ids)` query in chunks and merge the rows, so the generated
 * URL never blows past PostgREST's length limit. `runChunk` receives one chunk
 * of ids and returns the matching rows.
 */
export async function fetchInChunks<T>(
  ids: string[],
  runChunk: (chunk: string[]) => QueryResult<T>,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += PG_IN_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + PG_IN_CHUNK_SIZE);
    const { data, error } = await runChunk(chunk);
    if (error) throw error;
    if (data) out.push(...data);
  }
  return out;
}

/**
 * Read every matching row past PostgREST's 1000-row response cap by paging.
 * `runPage` runs one page given an inclusive [from, to] range (as passed to
 * Supabase's `.range()`).
 */
export async function fetchAllPages<T>(
  runPage: (from: number, to: number) => QueryResult<T>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PG_PAGE_SIZE) {
    const { data, error } = await runPage(from, from + PG_PAGE_SIZE - 1);
    if (error) throw error;
    const batch = data ?? [];
    out.push(...batch);
    if (batch.length < PG_PAGE_SIZE) break;
  }
  return out;
}
