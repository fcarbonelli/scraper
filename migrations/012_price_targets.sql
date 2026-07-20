-- =============================================================================
-- Price targets (Lista de Precios / "Price List") — PRECIO_TGT_SPM / _MAY.
--
-- The client sends a periodic price list (xlsx) with a target ("EDP") price per
-- EAN per commercial channel: SPM, MAY, MAY REG, PRO, DISTRI. We store all of
-- them in `price_targets` (keyed by ean+canal, upserted on every import) and
-- surface two of them in the client_base export:
--
--   PRECIO_TGT_SPM  = the LP 'SPM' EDP, shown ONLY on supermarket rows
--                     (supermarkets.canal LIKE 'SPM%')
--   PRECIO_TGT_MAY  = the LP 'MAY' EDP, shown ONLY on mayorista rows
--                     (supermarkets.canal LIKE 'MAY%')
--
-- So each export row shows the target for its OWN channel and leaves the other
-- empty ("one or the other, or empty"). MAY REG / PRO / DISTRI are stored but
-- not (yet) mapped to any export column.
--
-- Idempotent. The view is DROP + CREATE (reproducing migration 008 in full, plus
-- the two target joins) so this file is the self-contained latest definition.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. price_targets: one target price per (ean, canal), refreshed on each import.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS price_targets (
  ean                  text        NOT NULL,
  canal                text        NOT NULL,   -- SPM | MAY | MAY REG | PRO | DISTRI
  edp                  numeric(12,2),          -- the target price we surface
  precio_regular_caja  numeric(12,2),
  precio_unitario      numeric(12,2),
  codigo_lista         text,
  vigencia             date,
  anio                 integer,
  mes                  text,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ean, canal)
);

CREATE INDEX IF NOT EXISTS price_targets_ean_idx ON price_targets (ean);

-- -----------------------------------------------------------------------------
-- 2. client_base: same as migration 008, plus the two target-price columns.
-- -----------------------------------------------------------------------------
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

  -- Outcome status for this row (see migration 005).
  ps.status                                         AS "Estado",

  -- Pricing -----------------------------------------------------------------
  COALESCE(ps.list_price, ps.price)                 AS "Precio_Regular",

  CASE
    WHEN ps.list_price IS NOT NULL AND ps.list_price > ps.price THEN ps.price
    ELSE ps.offer_price_1
  END                                               AS "Precio_c_Oferta_1",

  ps.offer_price_2                                  AS "Precio_c_Oferta_2",
  ps.promotion_1                                    AS "Promocion_1",
  ps.promotion_2                                    AS "Promocion_2",

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

  -- Target prices from the client's Price List (migration 012). Each row shows
  -- only the target for its OWN channel: supermarket rows get the SPM target,
  -- mayorista rows get the MAY target; the other column stays NULL.
  CASE WHEN s.canal LIKE 'SPM%' THEN pt_spm.edp END AS "PRECIO_TGT_SPM",
  CASE WHEN s.canal LIKE 'MAY%' THEN pt_may.edp END AS "PRECIO_TGT_MAY",

  NULL::numeric                                     AS "IDX_VS_COMPETENCIA",
  NULL::numeric                                     AS "PRECIO_PRODUCTO_EN_CATEGORIA"

FROM price_snapshots ps
JOIN supermarket_products sp ON sp.id = ps.supermarket_product_id
JOIN products p              ON p.id  = sp.product_id
JOIN supermarkets s          ON s.id  = sp.supermarket_id
LEFT JOIN scrape_runs r      ON r.id  = ps.scrape_run_id
-- Target-price joins: match this product's EAN to the SPM and MAY price-list rows.
LEFT JOIN price_targets pt_spm ON pt_spm.ean = p.ean AND pt_spm.canal = 'SPM'
LEFT JOIN price_targets pt_may ON pt_may.ean = p.ean AND pt_may.canal = 'MAY'
-- Publication gate (migration 005): only published days, plus run-less ad-hoc /
-- manual snapshots. 'scrape_failed' is internal-only and never reaches clients.
WHERE (r.id IS NULL OR r.review_status = 'published')
  AND ps.status <> 'scrape_failed'
  -- Active gate (migration 008): a deactivated chain or a paused product mapping
  -- disappears from the client export entirely (history retained in the DB,
  -- reappears if re-activated). Delisted/out-of-stock products stay is_active
  -- and keep showing via their marker rows.
  AND s.is_active = true
  AND sp.is_active = true;
