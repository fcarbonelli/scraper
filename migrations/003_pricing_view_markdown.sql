-- =============================================================================
-- Fix client_base pricing semantics: regular price vs. offer price.
--
-- Problem (migration 002): the view labeled `price_snapshots.price` as
-- "Precio_Regular". But `price` is always the CURRENT SELLING price — i.e. the
-- already-discounted price when a product is on sale. The true regular price
-- lives in `list_price` (the crossed-out number). So for any marked-down product
-- (every VTEX store does this — e.g. Cordiez: list_price 4362.12, price 2999)
-- the client API reported the sale price AS the regular price, showed no offer,
-- and a null discount.
--
-- Fix (this migration): a single, general redefinition of the view — NOT
-- per-supermarket logic. All chains store the same two fields:
--   price       = what the shopper pays now (sale price when discounted)
--   list_price  = the regular/crossed-out price (only when there's a markdown)
--
-- Mapping now:
--   Precio_Regular      = list_price when present, else price
--   Precio_c_Oferta_1   = the sale price (price) when marked down,
--                         else the first named-promo offer price
--   Descuento_Unitario  = the larger of (named-promo discount) and
--                         (markdown gap = (list_price - price) / list_price)
--
-- `price_snapshots` is unchanged — `price` keeps meaning "current selling
-- price" so price history / alerts / comparisons stay intact. This is a
-- view-only, non-destructive change. Idempotent: drops + recreates the view.
--
-- Caveat (rare): a product that has BOTH a markdown AND a named promotion will
-- surface the shelf price in Precio_c_Oferta_1 and the named promo's computed
-- price is not shown in an offer column — but Precio_MasBajo still reflects the
-- true lowest price via LEAST(), so no price is lost.
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
