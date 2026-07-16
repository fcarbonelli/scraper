-- =============================================================================
-- client_base: hide deactivated chains and paused products from the client.
--
-- Bug: the view (migrations 002 → 004 → 005) joined `supermarkets` and
-- `supermarket_products` purely on their ids and NEVER filtered on `is_active`.
-- Result: a chain paused at the supermarket level (e.g. `mercadolibre`, flipped
-- is_active=false) still leaked ALL of its historical snapshots into the client
-- export, and a product paused with `PATCH /v1/supermarket-products/:id
-- { is_active:false }` kept showing too.
--
-- Fix: only surface rows whose chain AND mapping are both active.
--
-- Why this is SAFE w.r.t. the gap-free history design:
--   `is_active` and `lifecycle_status` are ORTHOGONAL levers (see
--   src/api/routes/supermarketProducts.ts):
--     - is_active=false      → "stop scraping here", operator pause. Now also
--                              hidden from the client; snapshots are retained in
--                              the DB and reappear the moment it's re-activated.
--     - lifecycle=delisted   → product is officially gone but STAYS is_active=true;
--       / out_of_stock         publish emits a marker row so the client history
--                              stays gap-free. These rows are NOT hidden here.
--   So delisted/out-of-stock products keep flowing (with their markers); only
--   genuinely paused chains/products drop out.
--
-- Everything else is identical to migration 005 (same 31-column shape, same
-- Estado column, same NULL-price tolerance, same published-runs-only rule).
-- Migrations 006 (revista layer) and 007 (catalog_extra_eans) did not touch the
-- view, so 005 is the definition we build on here.
--
-- DROP + CREATE (not CREATE OR REPLACE): reproducing the whole definition so this
-- file is the self-contained latest source of truth for the view. Idempotent.
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
  NULL::numeric                                     AS "PRECIO_TGT_SPM",
  NULL::numeric                                     AS "PRECIO_TGT_MAY",
  NULL::numeric                                     AS "IDX_VS_COMPETENCIA",
  NULL::numeric                                     AS "PRECIO_PRODUCTO_EN_CATEGORIA"

FROM price_snapshots ps
JOIN supermarket_products sp ON sp.id = ps.supermarket_product_id
JOIN products p              ON p.id  = sp.product_id
JOIN supermarkets s          ON s.id  = sp.supermarket_id
LEFT JOIN scrape_runs r      ON r.id  = ps.scrape_run_id
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
