-- =============================================================================
-- Preview export: include NOT-YET-APPROVED in-store entries.
--
-- In-store submissions are logged as PENDING `instore_price_entries` and only
-- become `price_snapshots` when a back-office operator approves the visit
-- (migration 019). So the preview export (`client_base_preview`, read by
-- GET /v1/data/export?preview=true) — which is meant to show EVERYTHING an
-- operator hasn't published yet — was missing them, because the view only reads
-- snapshots. This adds a second branch (UNION ALL) that projects each pending
-- in-store entry into the same client_base columns, so preview downloads show
-- them exactly as they'll appear once approved.
--
-- Scope: ONLY `client_base_preview` changes. The published `client_base` view
-- (migration 024) is untouched — pending entries never reach the client until
-- approved, same as before.
--
-- Notes on the pending branch:
--   * A pending entry may not have a master `products` row yet (catalog-only
--     EANs get one on approval), so we LEFT JOIN products and fall back to the
--     entry's own `ean` / `product_name`. The EAN guard uses COALESCE(p.ean,
--     e.ean) — the scanned EAN is always present, so it passes.
--   * No mapping/snapshot exists yet, so ID and URL are NULL. Estado mirrors the
--     approved output: 'En stock sin precio' for a no_price marker, else
--     'Disponible' (consistent with how preview already shows pending_review
--     online rows without a special "pending" label).
--   * Provincia/Zona/Canal/Cadena come from the supermarket row (same as the
--     approved in-store snapshots do — per-visit location isn't in the export).
--
-- Idempotent: safe to re-run.
-- =============================================================================

DROP VIEW IF EXISTS client_base_preview;

CREATE VIEW client_base_preview AS
-- -----------------------------------------------------------------------------
-- Branch 1: snapshots (migration 024 preview body, verbatim) — no publish gate.
-- -----------------------------------------------------------------------------
SELECT
  ps.id                                             AS "ID",
  ps.scraped_at                                     AS "Fecha_Creacion",
  ps.scraped_at                                     AS "Fecha_Actualizacion",
  s.provincia                                       AS "Provincia",
  s.zona                                            AS "Zona",
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
  s.canal                                           AS "Canal",
  COALESCE(s.cadena_display_name, UPPER(s.name))    AS "Cadena",
  p.category                                        AS "Categoria",
  p.subcategory                                     AS "Subcategoria",
  p.manufacturer                                    AS "Fabricante",
  p.brand                                           AS "Marca",
  p.format                                          AS "Formato",
  p.variety                                         AS "Variedad",
  p.description_forms                               AS "Descripcion_para_Forms",
  p.ean                                             AS "EAN",
  COALESCE(ps.site_product_name, p.name)            AS "Desc_Sku_Sitio",
  CASE ps.status
    WHEN 'ok'           THEN 'Disponible'
    WHEN 'out_of_stock' THEN 'Sin stock'
    WHEN 'not_found'    THEN 'No encontrado'
    WHEN 'delisted'     THEN 'Discontinuado'
    WHEN 'no_price'     THEN 'En stock sin precio'
    ELSE ps.status
  END                                               AS "Estado",
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
  sp.external_url                                   AS "URL",
  LEAST(
    ps.price,
    COALESCE(ps.offer_price_1, ps.price),
    COALESCE(ps.offer_price_2, ps.price)
  )                                                 AS "Precio_MasBajo",
  CASE WHEN s.canal LIKE 'SPM%' THEN pt_spm.edp END AS "PRECIO_TGT_SPM",
  CASE WHEN s.canal LIKE 'MAY%' AND s.canal <> 'MAY REGIONAL' THEN pt_may.edp END AS "PRECIO_TGT_WHS",
  CASE WHEN s.canal = 'MAY REGIONAL' THEN pt_may_reg.edp END AS "PRECIO_TGT_WHS_REG",
  NULL::numeric                                     AS "IDX_VS_COMPETENCIA",
  NULL::numeric                                     AS "PRECIO_PRODUCTO_EN_CATEGORIA"
FROM price_snapshots ps
JOIN supermarket_products sp ON sp.id = ps.supermarket_product_id
JOIN products p              ON p.id  = sp.product_id
JOIN supermarkets s          ON s.id  = sp.supermarket_id
LEFT JOIN scrape_runs r      ON r.id  = ps.scrape_run_id
LEFT JOIN price_targets pt_spm     ON pt_spm.ean     = p.ean AND pt_spm.canal     = 'SPM'
LEFT JOIN price_targets pt_may     ON pt_may.ean     = p.ean AND pt_may.canal     = 'MAY'
LEFT JOIN price_targets pt_may_reg ON pt_may_reg.ean = p.ean AND pt_may_reg.canal = 'MAY REG'
WHERE ps.status <> 'scrape_failed'
  AND s.is_active = true
  AND sp.is_active = true
  AND COALESCE(p.ean, '') <> ''

UNION ALL

-- -----------------------------------------------------------------------------
-- Branch 2: PENDING in-store entries (no snapshot yet) — preview only.
-- -----------------------------------------------------------------------------
SELECT
  NULL::bigint                                      AS "ID",
  e.created_at                                      AS "Fecha_Creacion",
  e.created_at                                      AS "Fecha_Actualizacion",
  s.provincia                                       AS "Provincia",
  s.zona                                            AS "Zona",
  (CASE EXTRACT(MONTH FROM e.created_at)::int
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
   END) || ' del ' || EXTRACT(YEAR FROM e.created_at)::int AS "Mes",
  EXTRACT(WEEK FROM e.created_at)::integer          AS "Semana",
  e.created_at::date                                AS "Fecha_Relevamiento",
  s.canal                                           AS "Canal",
  COALESCE(s.cadena_display_name, UPPER(s.name))    AS "Cadena",
  p.category                                        AS "Categoria",
  p.subcategory                                     AS "Subcategoria",
  p.manufacturer                                    AS "Fabricante",
  p.brand                                           AS "Marca",
  p.format                                          AS "Formato",
  p.variety                                         AS "Variedad",
  p.description_forms                               AS "Descripcion_para_Forms",
  COALESCE(p.ean, e.ean)                            AS "EAN",
  COALESCE(p.name, e.product_name)                  AS "Desc_Sku_Sitio",
  CASE WHEN e.no_price THEN 'En stock sin precio' ELSE 'Disponible' END AS "Estado",
  e.price                                           AS "Precio_Regular",
  e.promo_price                                     AS "Precio_c_Oferta_1",
  NULL::numeric                                     AS "Precio_c_Oferta_2",
  e.promo_text                                      AS "Promocion_1",
  NULL::text                                        AS "Promocion_2",
  NULL::numeric                                     AS "Descuento_Unitario",
  NULL::text                                        AS "URL",
  LEAST(e.price, COALESCE(e.promo_price, e.price))  AS "Precio_MasBajo",
  CASE WHEN s.canal LIKE 'SPM%' THEN pt_spm.edp END AS "PRECIO_TGT_SPM",
  CASE WHEN s.canal LIKE 'MAY%' AND s.canal <> 'MAY REGIONAL' THEN pt_may.edp END AS "PRECIO_TGT_WHS",
  CASE WHEN s.canal = 'MAY REGIONAL' THEN pt_may_reg.edp END AS "PRECIO_TGT_WHS_REG",
  NULL::numeric                                     AS "IDX_VS_COMPETENCIA",
  NULL::numeric                                     AS "PRECIO_PRODUCTO_EN_CATEGORIA"
FROM instore_price_entries e
JOIN supermarkets s      ON s.id = e.supermarket_id
LEFT JOIN products p     ON p.id = e.product_id
LEFT JOIN price_targets pt_spm     ON pt_spm.ean     = COALESCE(p.ean, e.ean) AND pt_spm.canal     = 'SPM'
LEFT JOIN price_targets pt_may     ON pt_may.ean     = COALESCE(p.ean, e.ean) AND pt_may.canal     = 'MAY'
LEFT JOIN price_targets pt_may_reg ON pt_may_reg.ean = COALESCE(p.ean, e.ean) AND pt_may_reg.canal = 'MAY REG'
WHERE e.review_status = 'pending'
  AND s.is_active = true
  AND COALESCE(p.ean, e.ean, '') <> '';
