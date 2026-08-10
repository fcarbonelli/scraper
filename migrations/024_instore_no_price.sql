-- =============================================================================
-- In-store "sin precio / hay stock" marker.
--
-- Field workers sometimes see a product on the shelf but can't read its price.
-- Until now they typed a fake $1 / $0, which (a) leaks a garbage price into the
-- client export and (b) forces the reviewer to hunt those down. Instead we let
-- them flag the case explicitly — the same idea as the scraper's out_of_stock
-- MARKER rows (a product row with NO price and a status).
--
-- This migration:
--   1. instore_price_entries.no_price  — the flag set when the worker taps
--      "Sin precio". price becomes NULL for those entries (so it's dropped its
--      NOT NULL). A real-price entry keeps no_price=false and a price.
--   2. Adds the Spanish `Estado` label for the new snapshot status 'no_price'
--      ('En stock sin precio') to BOTH client views. price_snapshots.status is
--      free-form text (no enum/CHECK), and price is already nullable
--      (migration 005), so approved no_price entries materialize as marker
--      snapshots (status='no_price', price=NULL) with every price column blank.
--
-- Everything else in the two views below is byte-for-byte migration 023 — the
-- only change is the extra `WHEN 'no_price'` branch in the Estado CASE.
--
-- ⚠️  KEEP IN SYNC: the two bodies differ ONLY in the publication gate
-- (client_base keeps it; client_base_preview omits it).
--
-- Idempotent: safe to re-run.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. instore_price_entries: no_price flag + nullable price
-- -----------------------------------------------------------------------------
ALTER TABLE instore_price_entries
  ADD COLUMN IF NOT EXISTS no_price boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN instore_price_entries.no_price IS
  'TRUE when the worker saw the product in stock but could not read its price '
  '(price is NULL). Materializes a status=''no_price'' marker snapshot on approval.';

-- price is NULL for no_price entries. DROP NOT NULL is a no-op if already dropped.
ALTER TABLE instore_price_entries ALTER COLUMN price DROP NOT NULL;

-- -----------------------------------------------------------------------------
-- 2. client_base (published-only) — migration 023 body + 'no_price' Estado label.
-- -----------------------------------------------------------------------------
DROP VIEW IF EXISTS client_base;

CREATE VIEW client_base AS
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
  -- Spanish label for the internal status code (migrations 022, 024).
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
WHERE (r.id IS NULL OR r.review_status = 'published')
  AND ps.status <> 'scrape_failed'
  AND s.is_active = true
  AND sp.is_active = true
  -- EAN guard (migration 021): never expose an EAN-less product to the client.
  AND COALESCE(p.ean, '') <> '';

-- -----------------------------------------------------------------------------
-- 3. client_base_preview (incl. pending_review) — same body, no publication gate.
-- -----------------------------------------------------------------------------
DROP VIEW IF EXISTS client_base_preview;

CREATE VIEW client_base_preview AS
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
  -- Spanish label for the internal status code (migrations 022, 024).
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
-- NO publication gate (preview includes pending_review). Same guards otherwise.
WHERE ps.status <> 'scrape_failed'
  AND s.is_active = true
  AND sp.is_active = true
  -- EAN guard (migration 021): never expose an EAN-less product.
  AND COALESCE(p.ean, '') <> '';
