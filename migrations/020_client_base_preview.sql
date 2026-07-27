-- =============================================================================
-- client_base_preview — the operator "check before you publish" view.
--
-- Identical to `client_base` (migration 012) in EVERY column, EXCEPT it drops
-- the publication gate: pending_review runs are included alongside published
-- ones. It powers `GET /v1/data/export?preview=true`, so an operator can
-- download today's freshly-scraped data to eyeball it BEFORE approving the day.
--
-- Everything else stays identical to the client-facing view:
--   - 'scrape_failed' is still excluded (internal-only pipeline marker)
--   - inactive chains / paused mappings are still hidden (is_active gates)
--   - same 31 columns, same order, same names
-- so the preview matches what WILL be published (minus not-yet-reconciled gaps,
-- since gap marker rows are only inserted at publish time).
--
-- ⚠️  KEEP IN SYNC: this body is a copy of `client_base` (migration 012) with a
-- single line removed (the review_status filter). If you ever change the
-- client_base columns, update BOTH. The client-facing view stays canonical.
--
-- This view exposes UNAPPROVED data. It is NOT part of the client contract
-- (`/v1/data/pricing` never reads it); only the operator export preview does.
--
-- Idempotent: safe to re-run.
-- =============================================================================

DROP VIEW IF EXISTS client_base_preview;

CREATE VIEW client_base_preview AS
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

  -- Target prices from the client's Price List (migration 012).
  CASE WHEN s.canal LIKE 'SPM%' THEN pt_spm.edp END AS "PRECIO_TGT_SPM",
  CASE WHEN s.canal LIKE 'MAY%' THEN pt_may.edp END AS "PRECIO_TGT_MAY",

  NULL::numeric                                     AS "IDX_VS_COMPETENCIA",
  NULL::numeric                                     AS "PRECIO_PRODUCTO_EN_CATEGORIA"

FROM price_snapshots ps
JOIN supermarket_products sp ON sp.id = ps.supermarket_product_id
JOIN products p              ON p.id  = sp.product_id
JOIN supermarkets s          ON s.id  = sp.supermarket_id
LEFT JOIN scrape_runs r      ON r.id  = ps.scrape_run_id
LEFT JOIN price_targets pt_spm ON pt_spm.ean = p.ean AND pt_spm.canal = 'SPM'
LEFT JOIN price_targets pt_may ON pt_may.ean = p.ean AND pt_may.canal = 'MAY'
-- NO publication gate here (the whole point): pending_review runs are included.
-- Everything else matches client_base: no internal 'scrape_failed', active only.
WHERE ps.status <> 'scrape_failed'
  AND s.is_active = true
  AND sp.is_active = true;
