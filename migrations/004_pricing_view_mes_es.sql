-- =============================================================================
-- Fix the "Mes" field in client_base: Spanish month name, no padding.
--
-- Problem (migration 003): "Mes" was built with
--   to_char(ps.scraped_at, 'TMMonth " del " YYYY')
-- which (a) depends on the server's lc_time locale — on our host it resolves to
-- English, e.g. "June" — and (b) uses the blank-padded `Month` pattern, which
-- left extra spaces ("June  del  2026").
--
-- The client expects Spanish month names in the form "Junio del 2026"
-- (their reference example: "Octubre del 2025").
--
-- Fix: map the month number to its Spanish name with an explicit CASE, so the
-- result is locale-independent and free of padding. Everything else in the view
-- is unchanged. View-only, non-destructive change (CREATE OR REPLACE).
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

  -- Pricing -----------------------------------------------------------------
  -- Regular (non-discounted) price: the crossed-out list_price when the product
  -- is marked down, otherwise the plain selling price.
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
