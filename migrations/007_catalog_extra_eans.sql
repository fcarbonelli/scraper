-- =============================================================================
-- 007: catalog_extra_eans — runtime-editable supplement to the official catalog
--
-- The client's official product list (211 EANs) is hardcoded in
-- src/shared/taxonomy.ts (TAXONOMY_BY_EAN). This table lets operators add NEW
-- official EANs at runtime (via POST /v1/catalog/eans) without a redeploy.
--
-- Coverage (GET /v1/data/coverage) and discovery read the UNION of the
-- hardcoded catalog and this table. See docs/PRODUCT_MANAGEMENT.md.
--
-- Idempotent: safe to re-run.
-- =============================================================================

CREATE TABLE IF NOT EXISTS catalog_extra_eans (
  ean               text        PRIMARY KEY,        -- EAN-13 barcode
  description_forms text        NOT NULL,           -- client's official description
  category          text,
  subcategory       text,
  brand             text,
  manufacturer      text,
  format            text,
  variety           text,
  created_by        text,                           -- optional operator label
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_catalog_extra_eans_category
  ON catalog_extra_eans (category) WHERE category IS NOT NULL;
