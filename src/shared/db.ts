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
