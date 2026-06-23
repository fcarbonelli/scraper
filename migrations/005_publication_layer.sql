-- =============================================================================
-- Publication & review layer.
--
-- Adds the "check the day, then release it" workflow on top of the existing
-- pipeline. Three orthogonal concepts, plus a client_base rewrite:
--
--   1. scrape_runs.review_status  — publication lifecycle, separate from the
--      execution `status` (running/completed/failed). A run is invisible to the
--      client until an operator publishes it:
--          pending_review  →  published
--
--   2. price_snapshots.status + nullable price — every product can have a row
--      every day even when there is NO price. Marker rows (price IS NULL) carry
--      a reason so the client history has no gaps:
--          ok | out_of_stock | not_found | scrape_failed | delisted
--
--   3. supermarket_products.lifecycle_status — product-level state for items
--      that are officially gone (not a transient failure):
--          active | out_of_stock | delisted
--
--   4. client_base rewrite — only reads PUBLISHED runs (plus run-less ad-hoc /
--      manual snapshots), exposes the new `Estado` column, and tolerates NULL
--      prices in the calculated columns.
--
-- Idempotent: safe to re-run.
--
-- No backfill: the publish workflow starts fresh from today. Existing runs stay
-- 'pending_review' (hidden from the client) until explicitly published. Run-less
-- ad-hoc/manual snapshots remain visible (see the client_base WHERE clause).
--
-- ROLLOUT ORDER (important): deploy this migration TOGETHER with the backend
-- changes that (a) finalize runs into `pending_review` and (b) expose a publish
-- path. With the migration alone, new daily runs default to `pending_review` and
-- stay hidden from the client until something publishes them.
-- =============================================================================

-- =============================================================================
-- 1. scrape_runs: publication lifecycle
-- =============================================================================

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'scrape_runs' AND column_name = 'published_at'
  ) THEN
    ALTER TABLE scrape_runs ADD COLUMN published_at timestamptz;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'scrape_runs' AND column_name = 'published_by'
  ) THEN
    ALTER TABLE scrape_runs ADD COLUMN published_by text;
  END IF;
END $$;

-- review_status. No backfill: existing runs default to 'pending_review', so the
-- publish workflow starts fresh from today. Historical runs are not shown to the
-- client until explicitly published (run-less ad-hoc/manual snapshots stay
-- visible via the client_base WHERE clause below).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'scrape_runs' AND column_name = 'review_status'
  ) THEN
    ALTER TABLE scrape_runs
      ADD COLUMN review_status text NOT NULL DEFAULT 'pending_review';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_runs_review_status
  ON scrape_runs (review_status, started_at DESC);

-- =============================================================================
-- 2. price_snapshots: per-row outcome status + nullable price
-- =============================================================================

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'price_snapshots' AND column_name = 'status'
  ) THEN
    -- 'ok'           → a real observed price
    -- 'out_of_stock' → confirmed out of stock (may or may not carry a price)
    -- 'not_found'    → product page returned 404 / gone from the site
    -- 'scrape_failed'→ we could not get the price this day (transient failure)
    -- 'delisted'     → product officially removed from this chain's catalog
    ALTER TABLE price_snapshots ADD COLUMN status text NOT NULL DEFAULT 'ok';
  END IF;
END $$;

-- Marker rows (out_of_stock / not_found / scrape_failed / delisted) have no
-- price, so `price` must be nullable. Existing rows all have a price, so this
-- is backward-compatible. DROP NOT NULL is a no-op if already dropped.
ALTER TABLE price_snapshots ALTER COLUMN price DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_snap_run_status
  ON price_snapshots (scrape_run_id, status) WHERE scrape_run_id IS NOT NULL;

-- =============================================================================
-- 3. supermarket_products: product-level lifecycle
-- =============================================================================

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'supermarket_products' AND column_name = 'lifecycle_status'
  ) THEN
    -- 'active'       → scrape normally
    -- 'out_of_stock' → known out of stock; runs emit an out_of_stock marker
    -- 'delisted'     → officially gone; runs emit a delisted marker
    ALTER TABLE supermarket_products
      ADD COLUMN lifecycle_status text NOT NULL DEFAULT 'active';
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'supermarket_products' AND column_name = 'lifecycle_note'
  ) THEN
    ALTER TABLE supermarket_products ADD COLUMN lifecycle_note text;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'supermarket_products' AND column_name = 'lifecycle_changed_at'
  ) THEN
    ALTER TABLE supermarket_products ADD COLUMN lifecycle_changed_at timestamptz;
  END IF;
END $$;

-- =============================================================================
-- 4. client_base rewrite
--
-- Same 31-column shape as migration 004, with three changes:
--   (a) LEFT JOIN scrape_runs and filter to PUBLISHED runs only. Snapshots with
--       no run (ad-hoc `scrape:url`, manual operator inserts) are operator-
--       trusted and stay visible.
--   (b) New `Estado` column surfacing price_snapshots.status.
--   (c) NULL-price tolerance: Precio_Regular / Precio_MasBajo / Descuento are
--       all NULL-safe (LEAST/GREATEST ignore NULLs; the discount CASE folds to
--       0 when price is NULL), so marker rows render as empty price + a status.
--
-- DROP + CREATE (not CREATE OR REPLACE): the new `Estado` column is inserted in
-- the middle of the column list, and CREATE OR REPLACE only allows appending
-- columns at the end. Dropping first is safe — the view holds no data.
-- =============================================================================

DROP VIEW IF EXISTS client_base;

CREATE VIEW client_base AS
SELECT
  -- Row metadata
  ps.id                                             AS "ID",
  ps.scraped_at                                     AS "Fecha_Creacion",
  ps.scraped_at                                     AS "Fecha_Actualizacion",

  -- Geography (static per supermarket)
  s.provincia                                       AS "Provincia",
  s.zona                                            AS "Zona",

  -- Time (derived from scraped_at) — Spanish month name, no padding.
  (CASE EXTRACT(MONTH FROM ps.scraped_at)::int
     WHEN 1  THEN 'Enero'
     WHEN 2  THEN 'Febrero'
     WHEN 3  THEN 'Marzo'
     WHEN 4  THEN 'Abril'
     WHEN 5  THEN 'Mayo'
     WHEN 6  THEN 'Junio'
     WHEN 7  THEN 'Julio'
     WHEN 8  THEN 'Agosto'
     WHEN 9  THEN 'Septiembre'
     WHEN 10 THEN 'Octubre'
     WHEN 11 THEN 'Noviembre'
     WHEN 12 THEN 'Diciembre'
   END) || ' del ' || EXTRACT(YEAR FROM ps.scraped_at)::int AS "Mes",
  EXTRACT(WEEK FROM ps.scraped_at)::integer         AS "Semana",
  ps.scraped_at::date                               AS "Fecha_Relevamiento",

  -- Channel / Chain
  s.canal                                           AS "Canal",
  COALESCE(s.cadena_display_name, UPPER(s.name))    AS "Cadena",

  -- Product taxonomy (static per EAN, from client reference sheet)
  p.category                                        AS "Categoria",
  p.subcategory                                     AS "Subcategoria",
  p.manufacturer                                    AS "Fabricante",
  p.brand                                           AS "Marca",
  p.format                                          AS "Formato",
  p.variety                                         AS "Variedad",
  p.description_forms                               AS "Descripcion_para_Forms",

  -- Product identification
  p.ean                                             AS "EAN",
  COALESCE(ps.site_product_name, p.name)            AS "Desc_Sku_Sitio",

  -- Outcome status for this row. Client-facing values describe a real-world
  -- situation: 'ok' (real price), 'out_of_stock', 'not_found', 'delisted'. The
  -- internal-only 'scrape_failed' (our pipeline couldn't get a price) is filtered
  -- out below, so it never reaches the client.
  ps.status                                         AS "Estado",

  -- Pricing -----------------------------------------------------------------
  -- Regular (non-discounted) price: the crossed-out list_price when the product
  -- is marked down, otherwise the plain selling price. NULL on marker rows.
  COALESCE(ps.list_price, ps.price)                 AS "Precio_Regular",

  -- First offer price: the current sale price when there's a markdown; else the
  -- first named-promotion offer price (payment-method deal, etc.), if any.
  CASE
    WHEN ps.list_price IS NOT NULL AND ps.list_price > ps.price THEN ps.price
    ELSE ps.offer_price_1
  END                                               AS "Precio_c_Oferta_1",

  ps.offer_price_2                                  AS "Precio_c_Oferta_2",
  ps.promotion_1                                    AS "Promocion_1",
  ps.promotion_2                                    AS "Promocion_2",

  -- Unit discount as a fraction (0-1): the greater of any named-promo discount
  -- and the markdown gap. NULL when there's no discount at all.
  NULLIF(
    GREATEST(
      COALESCE(ps.unit_discount, 0),
      CASE
        WHEN ps.list_price IS NOT NULL AND ps.list_price > ps.price
          THEN round(((ps.list_price - ps.price) / ps.list_price)::numeric, 4)
        ELSE 0
      END
    ),
    0
  )                                                 AS "Descuento_Unitario",

  -- URL
  sp.external_url                                   AS "URL",

  -- Calculated / Future. LEAST ignores NULLs, so marker rows yield NULL here.
  LEAST(
    ps.price,
    COALESCE(ps.offer_price_1, ps.price),
    COALESCE(ps.offer_price_2, ps.price)
  )                                                 AS "Precio_MasBajo",
  NULL::numeric                                     AS "PRECIO_TGT_SPM",
  NULL::numeric                                     AS "PRECIO_TGT_MAY",
  NULL::numeric                                     AS "IDX_VS_COMPETENCIA",
  NULL::numeric                                     AS "PRECIO_PRODUCTO_EN_CATEGORIA"

FROM price_snapshots ps
JOIN supermarket_products sp ON sp.id = ps.supermarket_product_id
JOIN products p              ON p.id  = sp.product_id
JOIN supermarkets s          ON s.id  = sp.supermarket_id
LEFT JOIN scrape_runs r      ON r.id  = ps.scrape_run_id
-- Only published days reach the client. Run-less snapshots (ad-hoc scrape:url,
-- manual operator inserts) are trusted and always visible. 'scrape_failed' is an
-- internal-only marker (operational failure, not a real product state) and is
-- never exposed to the client.
WHERE (r.id IS NULL OR r.review_status = 'published')
  AND ps.status <> 'scrape_failed';
