-- =============================================================================
-- Bank / card promotions layer  (Phase 7 — see docs/BANK_PROMOS.md)
--
-- A NEW, fully isolated module: it scrapes bank / credit-card promotions
-- (Naranja X first, more providers later), stores them with weekly history,
-- and is served through a SEPARATE API path (/v1/promos/*) gated by a new
-- `promos` API-key scope. It NEVER touches the supermarket price engine
-- (price_snapshots / client_base) or the existing client's data.
--
-- Model (mirrors the supermarkets/price_snapshots split):
--   promo_providers      — one row per source (bank/issuer). Analog of `supermarkets`.
--   promotions           — canonical, de-duplicated promo (latest known state),
--                          one row per (provider, external_id). Updated in place.
--   promotion_snapshots  — weekly history: what a promo looked like on a run.
--
-- `api_keys.scopes` already exists (migration 009). The `promos` scope is
-- enforced in code (src/api/middleware/auth.ts + src/api/routes/promos.ts).
--
-- Idempotent: safe to re-run.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";  -- gen_random_uuid()

-- =============================================================================
-- 1. promo_providers — the sources we scrape (banks / card issuers)
-- =============================================================================
CREATE TABLE IF NOT EXISTS promo_providers (
  id          text        PRIMARY KEY,               -- 'naranjax'
  name        text        NOT NULL,                  -- 'Naranja X'
  base_url    text,                                  -- BFF/API base (for reference)
  active      boolean     NOT NULL DEFAULT true,
  -- DB-driven config so tokens/headers/toggles can change without a redeploy
  -- (same pattern as supermarkets.config).
  config      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  last_run_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE promo_providers IS
  'Bank/card promotion sources (Naranja X, etc.). Analog of `supermarkets` for the promos module.';

-- =============================================================================
-- 2. promotions — canonical, de-duplicated promotion (latest known state)
-- =============================================================================
CREATE TABLE IF NOT EXISTS promotions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id     text        NOT NULL REFERENCES promo_providers(id) ON DELETE CASCADE,
  -- Stable id from the source (e.g. Naranja X binder id). Unique per provider.
  external_id     text        NOT NULL,

  title           text,                               -- "25% off y 12 cuotas cero interés"
  merchant        text,                               -- "Disco"
  category        text,                               -- taxonomy key, e.g. "SUPERMERCADOS"
  category_name   text,                               -- human label, e.g. "Supermercados"
  subcategory     text,                               -- e.g. "HIPERMERCADOS"
  subtitle        text,

  payment_methods text[],                             -- normalized keys: CREDITO/DEBITO/DINERO/VISA/...
  weekdays        text[],                             -- MONDAY..SUNDAY, or ['ALL_DAYS']
  purchase_modes  text[],                             -- ONLINE / IN_STORE

  -- Convenience numerics parsed from the plan titles (for sort/filter). The
  -- authoritative per-plan data lives in `plans` (jsonb) below.
  max_discount_pct int,
  max_installments int,

  valid_from      timestamptz,
  valid_to        timestamptz,

  url             text,                               -- commerce slug ("disco")
  full_url        text,                               -- canonical promo page URL
  logo_url        text,
  image_url       text,

  is_featured     boolean     NOT NULL DEFAULT false, -- appears in the homepage carousel
  is_active       boolean     NOT NULL DEFAULT true,  -- false once it drops off the source

  -- Lossless: the individual promo "plans" and tags, plus the whole raw payload,
  -- so we can re-derive columns later without re-scraping.
  plans           jsonb       NOT NULL DEFAULT '[]'::jsonb,
  tags            jsonb       NOT NULL DEFAULT '[]'::jsonb,
  raw             jsonb,

  first_seen      timestamptz NOT NULL DEFAULT now(),
  last_seen       timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  UNIQUE (provider_id, external_id)
);

COMMENT ON TABLE promotions IS
  'Canonical de-duplicated bank/card promotion (latest state). History in promotion_snapshots.';

CREATE INDEX IF NOT EXISTS idx_promotions_provider  ON promotions(provider_id);
CREATE INDEX IF NOT EXISTS idx_promotions_category  ON promotions(category);
CREATE INDEX IF NOT EXISTS idx_promotions_active    ON promotions(is_active);
CREATE INDEX IF NOT EXISTS idx_promotions_merchant  ON promotions(merchant);
-- Array containment filters (payment method / weekday) use GIN.
CREATE INDEX IF NOT EXISTS idx_promotions_pay_gin   ON promotions USING gin (payment_methods);
CREATE INDEX IF NOT EXISTS idx_promotions_days_gin  ON promotions USING gin (weekdays);

-- =============================================================================
-- 3. promotion_snapshots — weekly history of each promotion
-- =============================================================================
CREATE TABLE IF NOT EXISTS promotion_snapshots (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id  uuid        NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  provider_id   text        NOT NULL REFERENCES promo_providers(id) ON DELETE CASCADE,
  run_id        uuid,                                  -- groups one weekly run
  captured_at   timestamptz NOT NULL DEFAULT now(),
  -- Full normalized promotion at capture time (so history is self-contained).
  payload       jsonb       NOT NULL
);

COMMENT ON TABLE promotion_snapshots IS
  'Weekly snapshot of a promotion (history: appeared / changed / expired).';

CREATE INDEX IF NOT EXISTS idx_promo_snap_promo  ON promotion_snapshots(promotion_id);
CREATE INDEX IF NOT EXISTS idx_promo_snap_run    ON promotion_snapshots(run_id);
CREATE INDEX IF NOT EXISTS idx_promo_snap_time   ON promotion_snapshots(captured_at);

-- =============================================================================
-- 4. Seed the first provider (Naranja X). Idempotent.
-- =============================================================================
INSERT INTO promo_providers (id, name, base_url, active)
VALUES (
  'naranjax',
  'Naranja X',
  'https://bkn-promotions.naranjax.com/bff-promotions-web/api',
  true
)
ON CONFLICT (id) DO NOTHING;
