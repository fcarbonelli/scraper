-- =============================================================================
-- Promotions module — register Galicia, Macro & Santander (Playwright providers)
-- (Phase 7 — see docs/BANK_PROMOS.md / docs/BANK_PROMOS_ROADMAP.md)
--
-- Why:
--   These three big issuers publish public JSON promo catalogs, BUT their APIs
--   sit behind an F5 BIG-IP WAF that fingerprints the TLS handshake (JA3), so a
--   plain server-side `fetch` is rejected. Their adapters (src/promos/galicia.ts,
--   macro.ts, santander.ts) use the shared browser-fetch helper
--   (src/promos/browserFetch.ts): a real Chromium loads the bank's SPA and the
--   API is called in-page (real Chrome JA3 + correct CORS). Each promo is
--   attributed to its bank via the `issuer` column (mig 031).
--
--   - Galicia   → loyalty.bff.bancogalicia.com.ar/api/portal (public, in-page)
--   - Macro     → apipublic.macro.com.ar (public apikey captured in-page)
--   - Santander → www.santander.com.ar/bff-benefits (same-origin, in-page)
--
-- NOTE: these providers need Chromium available at runtime (Playwright — already
-- used by the Maxi Carrefour adapter). Per-provider launch tuning can be stored
-- in promo_providers.config.launch (e.g. {"headless":true,"useSystemChrome":false}).
-- Macro can be scoped to a subset of provinces via config.provinces.
--
-- Idempotent: safe to re-run.
-- =============================================================================

INSERT INTO promo_providers (id, name, base_url, active)
VALUES
  ('galicia',   'Banco Galicia',   'https://loyalty.bff.bancogalicia.com.ar/api/portal', true),
  ('macro',     'Banco Macro',     'https://apipublic.macro.com.ar/v1/card-benefits',    true),
  ('santander', 'Banco Santander', 'https://www.santander.com.ar/bff-benefits',          true)
ON CONFLICT (id) DO NOTHING;
