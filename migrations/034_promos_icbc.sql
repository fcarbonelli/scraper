-- =============================================================================
-- Promotions module — register ICBC (Playwright provider)
-- (Phase 7 — see docs/BANK_PROMOS.md / docs/BANK_PROMOS_ROADMAP.md)
--
-- Why:
--   ICBC's benefits SPA (beneficios.icbc.com.ar, a Vite app) is backed by a
--   public JSON API (prod-utilidades-icbc.pisol.net/api/web/v1) whose calls
--   carry two headers the SPA injects: a public `apikey` and an `accesstoken`.
--   Both rotate, so the adapter (src/promos/icbc.ts) uses the shared
--   browser-fetch helper (src/promos/browserFetch.ts): a real Chromium loads
--   the SPA, captures both headers in-page (never logged), then replays the
--   API. The catalog is organized by rubro (category); we enumerate rubros and
--   paginate each via /beneficios/get?heading_id=<id>&offset=N&limit=M. Each
--   promo is attributed issuer='ICBC' (mig 031).
--
-- NOTE: needs Chromium at runtime (Playwright — already used by Maxi Carrefour +
-- the Galicia/Macro/Santander adapters). Per-provider launch tuning can be
-- stored in promo_providers.config.launch (e.g. {"headless":true}).
--
-- Idempotent: safe to re-run.
-- =============================================================================

INSERT INTO promo_providers (id, name, base_url, active)
VALUES (
  'icbc',
  'ICBC',
  'https://prod-utilidades-icbc.pisol.net/api/web/v1',
  true
)
ON CONFLICT (id) DO NOTHING;
