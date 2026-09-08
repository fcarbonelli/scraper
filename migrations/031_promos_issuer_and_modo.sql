-- =============================================================================
-- Promotions module — add `issuer` + register the MODO aggregator provider
-- (Phase 7 — see docs/BANK_PROMOS.md / docs/BANK_PROMOS_ROADMAP.md)
--
-- Why:
--   * `issuer` is the bank / card entity behind each promo ("Galicia",
--     "Credicoop", "MODO" for cross-bank, "Naranja X"). It is the key filter
--     dimension for multi-bank aggregators. Existing rows keep NULL until the
--     next run backfills them.
--   * MODO (modo.com.ar/promos) aggregates ~80 banks' pay-with-MODO promotions
--     into one public catalog, so one adapter (`src/promos/modo.ts`) covers most
--     of the roadmap in a single provider.
--
-- Idempotent: safe to re-run.
-- =============================================================================

-- 1. issuer column on the canonical promotions table --------------------------
ALTER TABLE promotions ADD COLUMN IF NOT EXISTS issuer text;

COMMENT ON COLUMN promotions.issuer IS
  'Issuing bank / card entity behind the promo (e.g. "Galicia", "Credicoop", '
  '"MODO" for cross-bank, "Naranja X"). Key filter dimension for aggregators.';

CREATE INDEX IF NOT EXISTS idx_promotions_issuer ON promotions(issuer);

-- 2. register the MODO provider ------------------------------------------------
INSERT INTO promo_providers (id, name, base_url, active)
VALUES (
  'modo',
  'MODO',
  'https://www.modo.com.ar/promos/api/rewards',
  true
)
ON CONFLICT (id) DO NOTHING;
