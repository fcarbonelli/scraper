-- =============================================================================
-- Initial schema for the price scraping platform
--
-- Run this in the Supabase SQL Editor (Dashboard > SQL Editor > New Query).
-- It is idempotent: safe to re-run; everything uses IF NOT EXISTS.
-- =============================================================================

-- Required extensions ---------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "pgcrypto";  -- for gen_random_uuid()

-- =============================================================================
-- products: master catalog (one row per "real" product)
-- The same product (e.g. "Coca Cola 500ml") sold at multiple supermarkets
-- maps to ONE row here, joined via supermarket_products.
-- =============================================================================
CREATE TABLE IF NOT EXISTS products (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL,
  category    text,
  brand       text,
  unit        text,                          -- "500ml", "2 Litro", "1 Kg", etc.
  ean         text,                          -- barcode; cross-supermarket join key
  metadata    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_products_ean
  ON products (ean) WHERE ean IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_products_category
  ON products (category) WHERE category IS NOT NULL;

-- =============================================================================
-- supermarkets: per-supermarket runtime config (DB-driven, no deploy to change)
-- =============================================================================
CREATE TABLE IF NOT EXISTS supermarkets (
  id              text        PRIMARY KEY,    -- "coto", "carrefour", etc.
  name            text        NOT NULL,
  is_active       boolean     NOT NULL DEFAULT true,
  base_url        text,
  rate_limit_ms   integer     NOT NULL DEFAULT 500,
  concurrency     integer     NOT NULL DEFAULT 3,
  config          jsonb       NOT NULL DEFAULT '{}'::jsonb,  -- adapter-specific
  health_status   text        NOT NULL DEFAULT 'unknown',    -- 'healthy' | 'degraded' | 'down' | 'unknown'
  last_run_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- supermarket_products: the mapping (this product exists at this supermarket)
-- =============================================================================
CREATE TABLE IF NOT EXISTS supermarket_products (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  supermarket_id  text        NOT NULL REFERENCES supermarkets(id) ON DELETE CASCADE,
  product_id      uuid        NOT NULL REFERENCES products(id)     ON DELETE CASCADE,
  external_id     text        NOT NULL,    -- supermarket's SKU
  external_url    text,                    -- canonical product page URL (no scraping params)
  is_active       boolean     NOT NULL DEFAULT true,
  metadata        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (supermarket_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_smp_supermarket
  ON supermarket_products (supermarket_id) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_smp_product
  ON supermarket_products (product_id);

-- =============================================================================
-- scrape_runs: one row per orchestration cycle (daily)
-- =============================================================================
CREATE TABLE IF NOT EXISTS scrape_runs (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  status       text        NOT NULL DEFAULT 'running',  -- 'running' | 'completed' | 'failed'
  total_jobs   integer     NOT NULL DEFAULT 0,
  succeeded    integer     NOT NULL DEFAULT 0,
  failed       integer     NOT NULL DEFAULT 0,
  retried      integer     NOT NULL DEFAULT 0,
  metadata     jsonb       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_runs_started
  ON scrape_runs (started_at DESC);

-- =============================================================================
-- price_snapshots: the core data table — one row per product per scrape attempt
-- This is what the API reads from.
-- =============================================================================
CREATE TABLE IF NOT EXISTS price_snapshots (
  id                       bigserial   PRIMARY KEY,
  supermarket_product_id   uuid        NOT NULL REFERENCES supermarket_products(id) ON DELETE CASCADE,
  scrape_run_id            uuid        REFERENCES scrape_runs(id) ON DELETE SET NULL,
  scraped_at               timestamptz NOT NULL DEFAULT now(),
  price                    numeric(12,2) NOT NULL,
  list_price               numeric(12,2),                -- crossed-out price (nullable)
  unit_price               numeric(12,2),                -- per-unit price (nullable)
  unit_price_per           text,                         -- "Litro", "Kg", "100g" (nullable)
  in_stock                 boolean     NOT NULL,
  currency                 text        NOT NULL DEFAULT 'ARS',
  tier_used                text        NOT NULL,         -- 'api' | 'html' | 'ai'
  promotions               jsonb       NOT NULL DEFAULT '[]'::jsonb,
  raw_data                 jsonb       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_snap_product_time
  ON price_snapshots (supermarket_product_id, scraped_at DESC);
CREATE INDEX IF NOT EXISTS idx_snap_run
  ON price_snapshots (scrape_run_id) WHERE scrape_run_id IS NOT NULL;

-- =============================================================================
-- job_executions: forensic record of every scrape attempt (success or fail).
-- This is what powers "exactly what failed and why" investigation.
-- =============================================================================
CREATE TABLE IF NOT EXISTS job_executions (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  scrape_run_id             uuid        REFERENCES scrape_runs(id) ON DELETE SET NULL,
  supermarket_product_id    uuid        NOT NULL REFERENCES supermarket_products(id) ON DELETE CASCADE,
  attempt                   integer     NOT NULL DEFAULT 1,
  tier_used                 text,
  status                    text        NOT NULL,        -- 'success' | 'failed' | 'retrying'
  error_type                text,                         -- 'network_timeout' | '404' | 'selector_failed' | etc.
  error_message             text,
  error_stack               text,
  duration_ms               integer,
  started_at                timestamptz NOT NULL DEFAULT now(),
  finished_at               timestamptz
);

CREATE INDEX IF NOT EXISTS idx_jobexec_run_status
  ON job_executions (scrape_run_id, status);
CREATE INDEX IF NOT EXISTS idx_jobexec_smp
  ON job_executions (supermarket_product_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobexec_failed_recent
  ON job_executions (started_at DESC) WHERE status = 'failed';

-- =============================================================================
-- alerts: things that need human attention
-- =============================================================================
CREATE TABLE IF NOT EXISTS alerts (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  severity        text        NOT NULL,                  -- 'info' | 'warning' | 'critical'
  type            text        NOT NULL,                  -- 'supermarket_degraded' | 'selector_broken' | etc.
  supermarket_id  text        REFERENCES supermarkets(id) ON DELETE SET NULL,
  product_id      uuid        REFERENCES products(id)    ON DELETE SET NULL,
  title           text        NOT NULL,
  message         text        NOT NULL,
  context         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status          text        NOT NULL DEFAULT 'open',   -- 'open' | 'acknowledged' | 'resolved'
  created_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz
);

CREATE INDEX IF NOT EXISTS idx_alerts_open_severity
  ON alerts (severity, created_at DESC) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_alerts_supermarket
  ON alerts (supermarket_id) WHERE supermarket_id IS NOT NULL;

-- =============================================================================
-- api_keys: simple API authentication
-- key_hash = bcrypt of the actual key. Plaintext is shown ONCE on creation.
-- =============================================================================
CREATE TABLE IF NOT EXISTS api_keys (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text        NOT NULL,                    -- "frontend", "internal-test"
  key_hash      text        NOT NULL UNIQUE,
  is_active     boolean     NOT NULL DEFAULT true,
  rate_limit    integer     NOT NULL DEFAULT 60,         -- requests per minute
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz
);

-- =============================================================================
-- Convenience: auto-update products.updated_at on any change
-- =============================================================================
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_products_touch ON products;
CREATE TRIGGER trg_products_touch
  BEFORE UPDATE ON products
  FOR EACH ROW
  EXECUTE FUNCTION touch_updated_at();
