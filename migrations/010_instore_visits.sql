-- =============================================================================
-- In-store: PDV visits, flyer photos, and richer entry fields.
--
-- Client review feedback on the in-store tool:
--   1. Each PDV (point of sale) needs address / locality / province — a chain has
--      many branches and a worker visits a specific one. We model a "visit"
--      (relevamiento): one worker at one store location on one occasion.
--   2. Four capture fields per product:
--        - Precio Regular (unitario)            → instore_price_entries.price
--        - Precio con oferta (precio mayorista) → instore_price_entries.promo_price
--        - Promoción: a partir de cuántas u. es precio mayorista → promo_min_units (NEW)
--        - Observaciones                        → instore_price_entries.note
--   3. Upload flyer / offer photos (instead of marking each product's promo) →
--      instore_photos, attached to a visit.
--   4. A "finish visit" action to save the relevamiento and leave the PDV →
--      instore_visits.status / finished_at.
--
-- Idempotent: safe to re-run.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =============================================================================
-- 1. instore_visits — one relevamiento of one PDV (store branch) by one worker
-- =============================================================================
CREATE TABLE IF NOT EXISTS instore_visits (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  supermarket_id  text        NOT NULL REFERENCES supermarkets(id) ON DELETE CASCADE,
  -- The specific branch location (item 1). A chain (supermarkets row) has many
  -- branches, so location lives on the visit, not the chain.
  provincia       text,
  localidad       text,
  direccion       text,
  -- Attribution: the worker's free-text name (saved in their browser).
  entered_by      text        NOT NULL,
  note            text,
  status          text        NOT NULL DEFAULT 'open',   -- 'open' | 'finished'
  api_key_id      uuid        REFERENCES api_keys(id) ON DELETE SET NULL,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);

CREATE INDEX IF NOT EXISTS idx_instore_visits_super
  ON instore_visits (supermarket_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_instore_visits_status
  ON instore_visits (status, started_at DESC);

-- =============================================================================
-- 2. instore_price_entries — link to a visit + wholesale min-units (items 1,2)
-- =============================================================================
ALTER TABLE instore_price_entries
  ADD COLUMN IF NOT EXISTS visit_id        uuid REFERENCES instore_visits(id) ON DELETE SET NULL,
  -- "a partir de cuántas unidades es precio mayorista" (promo_price is that price).
  ADD COLUMN IF NOT EXISTS promo_min_units integer;

CREATE INDEX IF NOT EXISTS idx_instore_entries_visit
  ON instore_price_entries (visit_id);

-- =============================================================================
-- 3. instore_photos — flyer / offer photos uploaded during a visit (item 3)
-- =============================================================================
CREATE TABLE IF NOT EXISTS instore_photos (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id        uuid        REFERENCES instore_visits(id) ON DELETE CASCADE,
  supermarket_id  text        NOT NULL REFERENCES supermarkets(id) ON DELETE CASCADE,
  url             text        NOT NULL,          -- public Supabase Storage URL
  storage_path    text,
  caption         text,
  entered_by      text,
  api_key_id      uuid        REFERENCES api_keys(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_instore_photos_visit
  ON instore_photos (visit_id);
CREATE INDEX IF NOT EXISTS idx_instore_photos_super
  ON instore_photos (supermarket_id, created_at DESC);
