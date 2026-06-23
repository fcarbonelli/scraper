/**
 * MercadoLibre OAuth token manager.
 *
 * MercadoLibre's API has no anonymous access — every request needs a Bearer
 * token tied to a user who authorized our app. The flow:
 *
 *   1. ONE-TIME bootstrap (`npm run ml:auth`): the operator authorizes the app
 *      in a browser; we exchange the returned `code` for an access token + a
 *      long-lived refresh token (requires the app's "offline_access" /
 *      "refresh token" grant). Both are stored in supermarkets.config.mlTokens.
 *   2. RUNTIME (this module): adapters call `getAccessToken()`. The access
 *      token lasts ~6h; when it's near expiry we transparently exchange the
 *      refresh token for a fresh pair and persist it. Refresh tokens ROTATE
 *      (each refresh returns a new one and invalidates the old), so we always
 *      write the new refresh token back to the DB.
 *
 * Token storage lives in `supermarkets.config.mlTokens` (JSONB), mirroring the
 * Maxi/Carrefour session pattern — survives restarts and is shared across the
 * worker / discovery process. Client id/secret come from env (they're secrets,
 * not per-run state).
 *
 * Concurrency: a process-level singleton dedupes simultaneous refreshes so N
 * parallel scrapes don't each try to spend the (single-use) refresh token.
 */

import { env } from '../shared/env.js';
import { ScrapeError } from '../shared/errors.js';

const SUPERMARKET_ID = 'mercadolibre';
const TOKEN_URL = 'https://api.mercadolibre.com/oauth/token';
const AUTH_BASE = 'https://auth.mercadolibre.com.ar/authorization';

// Refresh a bit before the real expiry so an in-flight request never races the
// boundary. ML access tokens last ~6h; 5 min of slack is plenty.
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

export interface MlTokens {
  accessToken: string;
  refreshToken: string;
  /** ISO timestamp when the access token expires. */
  expiresAt: string;
  refreshedAt?: string;
  userId?: number;
}

/** Raw shape of the /oauth/token response. */
interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds
  user_id?: number;
  token_type?: string;
  scope?: string;
}

// In-memory cache so we don't hit the DB on every single call (a discovery run
// makes hundreds). Refilled from the DB on first use and updated on refresh.
let cached: MlTokens | undefined;
let refreshInFlight: Promise<MlTokens> | undefined;

// =============================================================================
// Persistence (supermarkets.config.mlTokens)
// =============================================================================

function parseTokens(value: unknown): MlTokens | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const t = value as Record<string, unknown>;
  if (typeof t.accessToken !== 'string' || typeof t.refreshToken !== 'string') {
    return undefined;
  }
  if (typeof t.expiresAt !== 'string') return undefined;
  const out: MlTokens = {
    accessToken: t.accessToken,
    refreshToken: t.refreshToken,
    expiresAt: t.expiresAt,
  };
  if (typeof t.refreshedAt === 'string') out.refreshedAt = t.refreshedAt;
  if (typeof t.userId === 'number') out.userId = t.userId;
  return out;
}

async function readTokensFromDb(): Promise<MlTokens | undefined> {
  const { db } = await import('../shared/db.js');
  const { data, error } = await db
    .from('supermarkets')
    .select('config')
    .eq('id', SUPERMARKET_ID)
    .single();
  if (error) {
    throw new ScrapeError('auth_required', `MercadoLibre: failed to read tokens: ${error.message}`);
  }
  const cfg = (data?.config ?? {}) as Record<string, unknown>;
  return parseTokens(cfg.mlTokens);
}

/** Merge fresh tokens into supermarkets.config.mlTokens without clobbering. */
async function writeTokensToDb(tokens: MlTokens): Promise<void> {
  const { db } = await import('../shared/db.js');
  const { data, error: readErr } = await db
    .from('supermarkets')
    .select('config')
    .eq('id', SUPERMARKET_ID)
    .single();
  if (readErr) {
    throw new ScrapeError('auth_required', `MercadoLibre: failed to read config: ${readErr.message}`);
  }
  const existing = (data?.config ?? {}) as Record<string, unknown>;
  const { error: writeErr } = await db
    .from('supermarkets')
    .update({ config: { ...existing, mlTokens: tokens } })
    .eq('id', SUPERMARKET_ID);
  if (writeErr) {
    throw new ScrapeError('auth_required', `MercadoLibre: failed to persist tokens: ${writeErr.message}`);
  }
}

// =============================================================================
// OAuth requests
// =============================================================================

function assertCredentials(): void {
  if (!env.ML_CLIENT_ID || !env.ML_CLIENT_SECRET) {
    throw new ScrapeError(
      'auth_required',
      'MercadoLibre: ML_CLIENT_ID / ML_CLIENT_SECRET are not set in the environment.',
    );
  }
}

async function postToken(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params).toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new ScrapeError(
      'auth_required',
      `MercadoLibre token endpoint returned HTTP ${res.status}: ${text.slice(0, 300)}`,
    );
  }
  try {
    return JSON.parse(text) as TokenResponse;
  } catch {
    throw new ScrapeError('auth_required', `MercadoLibre token response was not JSON: ${text.slice(0, 200)}`);
  }
}

function toTokens(r: TokenResponse): MlTokens {
  const tokens: MlTokens = {
    accessToken: r.access_token,
    refreshToken: r.refresh_token,
    expiresAt: new Date(Date.now() + r.expires_in * 1000).toISOString(),
    refreshedAt: new Date().toISOString(),
  };
  if (typeof r.user_id === 'number') tokens.userId = r.user_id;
  return tokens;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Build the authorization URL the operator opens once to grant access.
 * `state` is echoed back on the redirect — used to guard against stray codes.
 */
export function buildAuthUrl(state: string): string {
  assertCredentials();
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: env.ML_CLIENT_ID,
    redirect_uri: env.ML_REDIRECT_URI,
    // offline_access → we get a refresh token; read → product/catalog reads.
    scope: 'offline_access read',
    state,
  });
  return `${AUTH_BASE}?${params.toString()}`;
}

/**
 * Exchange a one-time authorization `code` (from the redirect) for tokens and
 * persist them. Called by the `ml:auth` bootstrap script.
 */
export async function exchangeCodeForTokens(code: string): Promise<MlTokens> {
  assertCredentials();
  const resp = await postToken({
    grant_type: 'authorization_code',
    client_id: env.ML_CLIENT_ID,
    client_secret: env.ML_CLIENT_SECRET,
    code,
    redirect_uri: env.ML_REDIRECT_URI,
  });
  const tokens = toTokens(resp);
  await writeTokensToDb(tokens);
  cached = tokens;
  return tokens;
}

/** Spend the (rotating) refresh token for a fresh access+refresh pair. */
async function refreshTokens(current: MlTokens): Promise<MlTokens> {
  assertCredentials();
  const resp = await postToken({
    grant_type: 'refresh_token',
    client_id: env.ML_CLIENT_ID,
    client_secret: env.ML_CLIENT_SECRET,
    refresh_token: current.refreshToken,
  });
  const tokens = toTokens(resp);
  await writeTokensToDb(tokens);
  cached = tokens;
  return tokens;
}

function isExpired(tokens: MlTokens): boolean {
  return Date.parse(tokens.expiresAt) - Date.now() <= EXPIRY_BUFFER_MS;
}

/**
 * Return a valid access token, refreshing transparently when needed.
 *
 * @param force  When true, refresh even if the cached token looks valid (used
 *               by the adapter after a 401, in case the token was revoked).
 *
 * Throws `auth_required` if no tokens are stored yet — run `npm run ml:auth`.
 */
export async function getAccessToken(force = false): Promise<string> {
  if (!cached) cached = await readTokensFromDb();
  if (!cached) {
    throw new ScrapeError(
      'auth_required',
      'MercadoLibre: no tokens stored. Run `npm run ml:auth` to authorize the app first.',
    );
  }

  if (!force && !isExpired(cached)) return cached.accessToken;

  // Dedupe concurrent refreshes: the refresh token is single-use, so two
  // parallel refreshes would invalidate each other.
  if (!refreshInFlight) {
    const current = cached;
    refreshInFlight = refreshTokens(current).finally(() => {
      refreshInFlight = undefined;
    });
  }
  const refreshed = await refreshInFlight;
  return refreshed.accessToken;
}

/** Test hook: drop the in-memory cache so the next call re-reads the DB. */
export function clearTokenCache(): void {
  cached = undefined;
}
