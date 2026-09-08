-- =============================================================================
-- Promotions module — register the BBVA provider
-- (Phase 7 — see docs/BANK_PROMOS.md / docs/BANK_PROMOS_ROADMAP.md)
--
-- Why:
--   * BBVA publishes its full benefits catalog (bbva.com.ar/beneficios) through
--     the public "Go" JSON API (go.bbva.com.ar/willgo/fgo/API) — no auth, just
--     browser headers. ~900 card promos across ~46 pages. Adapter lives in
--     `src/promos/bbva.ts`; each promo is attributed with issuer='BBVA'.
--   * BBVA promos partially overlap MODO's QR feed but add BBVA card-only
--     promotions (installments, Visa/Master benefits) that MODO does not carry.
--
-- Idempotent: safe to re-run.
-- =============================================================================

INSERT INTO promo_providers (id, name, base_url, active)
VALUES (
  'bbva',
  'BBVA',
  'https://go.bbva.com.ar/willgo/fgo/API',
  true
)
ON CONFLICT (id) DO NOTHING;
