-- =============================================================================
-- Client schema enrichment: "Estructura de Base"
--
-- Adds geography/channel metadata to supermarkets, product taxonomy columns
-- to products, flat promotion fields to price_snapshots, and a client_base
-- view that joins everything into the 31-column flat structure the client
-- expects from GET /api/v1/data/pricing.
--
-- Idempotent: safe to re-run. All DDL uses IF NOT EXISTS or OR REPLACE.
-- =============================================================================

-- =============================================================================
-- 1. Enrich supermarkets with geography and channel metadata
-- =============================================================================

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'supermarkets' AND column_name = 'provincia'
  ) THEN
    ALTER TABLE supermarkets ADD COLUMN provincia text;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'supermarkets' AND column_name = 'zona'
  ) THEN
    ALTER TABLE supermarkets ADD COLUMN zona text;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'supermarkets' AND column_name = 'canal'
  ) THEN
    ALTER TABLE supermarkets ADD COLUMN canal text;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'supermarkets' AND column_name = 'cadena_display_name'
  ) THEN
    ALTER TABLE supermarkets ADD COLUMN cadena_display_name text;
  END IF;
END $$;

-- =============================================================================
-- 2. Enrich products with client taxonomy fields
-- =============================================================================

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'products' AND column_name = 'subcategory'
  ) THEN
    ALTER TABLE products ADD COLUMN subcategory text;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'products' AND column_name = 'manufacturer'
  ) THEN
    ALTER TABLE products ADD COLUMN manufacturer text;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'products' AND column_name = 'format'
  ) THEN
    ALTER TABLE products ADD COLUMN format text;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'products' AND column_name = 'variety'
  ) THEN
    ALTER TABLE products ADD COLUMN variety text;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'products' AND column_name = 'description_forms'
  ) THEN
    ALTER TABLE products ADD COLUMN description_forms text;
  END IF;
END $$;

-- =============================================================================
-- 3. Enrich price_snapshots with flat promotion columns
-- =============================================================================

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'price_snapshots' AND column_name = 'offer_price_1'
  ) THEN
    ALTER TABLE price_snapshots ADD COLUMN offer_price_1 numeric(12,2);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'price_snapshots' AND column_name = 'offer_price_2'
  ) THEN
    ALTER TABLE price_snapshots ADD COLUMN offer_price_2 numeric(12,2);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'price_snapshots' AND column_name = 'promotion_1'
  ) THEN
    ALTER TABLE price_snapshots ADD COLUMN promotion_1 text;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'price_snapshots' AND column_name = 'promotion_2'
  ) THEN
    ALTER TABLE price_snapshots ADD COLUMN promotion_2 text;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'price_snapshots' AND column_name = 'unit_discount'
  ) THEN
    ALTER TABLE price_snapshots ADD COLUMN unit_discount numeric(5,4);
  END IF;
END $$;

-- Desc_Sku_Sitio: the product name as shown on the scraped website.
-- Stored per-snapshot because different supermarkets use different names
-- for the same EAN.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'price_snapshots' AND column_name = 'site_product_name'
  ) THEN
    ALTER TABLE price_snapshots ADD COLUMN site_product_name text;
  END IF;
END $$;

-- =============================================================================
-- 4. Client-facing view: flat 31-column structure
--
-- Joins price_snapshots → supermarket_products → products → supermarkets
-- into the exact shape the client's reporting tools expect.
-- =============================================================================

CREATE OR REPLACE VIEW client_base AS
SELECT
  -- Row metadata
  ps.id                                             AS "ID",
  ps.scraped_at                                     AS "Fecha_Creacion",
  ps.scraped_at                                     AS "Fecha_Actualizacion",

  -- Geography (static per supermarket)
  s.provincia                                       AS "Provincia",
  s.zona                                            AS "Zona",

  -- Time (derived from scraped_at)
  to_char(ps.scraped_at, 'TMMonth " del " YYYY')   AS "Mes",
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

  -- Pricing
  ps.price                                          AS "Precio_Regular",
  ps.offer_price_1                                  AS "Precio_c_Oferta_1",
  ps.offer_price_2                                  AS "Precio_c_Oferta_2",
  ps.promotion_1                                    AS "Promocion_1",
  ps.promotion_2                                    AS "Promocion_2",
  ps.unit_discount                                  AS "Descuento_Unitario",

  -- URL
  sp.external_url                                   AS "URL",

  -- Calculated / Future
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
JOIN supermarkets s          ON s.id  = sp.supermarket_id;
