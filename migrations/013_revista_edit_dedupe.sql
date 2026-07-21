-- =============================================================================
-- Revista: edit overrides + enriched item view (+ scraped_on helper column).
--
-- 1. scraped_on (date) on price_snapshots — Buenos Aires calendar day. Used by
--    the idempotent writer and duplicate-detection endpoints. NOT constrained
--    by a unique index (defence is the control view + resolve action; see
--    docs/REVISTA_REVIEW.md). A future migration may add:
--      CREATE UNIQUE INDEX uq_revista_snapshot_per_day
--        ON price_snapshots (supermarket_product_id, scraped_on)
--        WHERE scrape_run_id IS NULL
--          AND scraped_on IS NOT NULL
--          AND (raw_data->>'source') IN ('revista', 'revista-carry-forward');
-- 2. approved_override jsonb on revista_review_items — operator corrections
--    without overwriting the AI `extracted` blob.
-- 3. revista_items_enriched view — powers GET /v1/revistas/items (search +
--    magazine/chain context + effective prices).
--
-- Idempotent: safe to re-run.
-- =============================================================================

-- 1. Calendar day column (nullable so existing rows backfill cleanly).
ALTER TABLE price_snapshots
  ADD COLUMN IF NOT EXISTS scraped_on date;

-- Backfill from scraped_at in Argentina time (UTC-3, no DST for BA).
UPDATE price_snapshots
SET scraped_on = (scraped_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
WHERE scraped_on IS NULL;

-- Drop the unique index if a previous draft of this migration created it.
-- Defence against duplicates is the control-view alert + resolve endpoint,
-- not a DB constraint (decision 2026-07-21).
DROP INDEX IF EXISTS uq_revista_snapshot_per_day;

-- 2. Operator override blob (does not overwrite extracted).
ALTER TABLE revista_review_items
  ADD COLUMN IF NOT EXISTS approved_override jsonb;

-- 3. Enriched list view for the control / aprobados screens.
DROP VIEW IF EXISTS revista_items_enriched;
CREATE VIEW revista_items_enriched AS
SELECT
  i.id,
  i.magazine_id,
  i.supermarket_id,
  s.name                                              AS supermarket_name,
  m.label                                             AS magazine_label,
  m.source_url,
  m.status                                            AS magazine_status,
  i.page_number,
  i.page_image_url,
  i.extracted,
  i.approved_override,
  -- Effective prices: override beats extracted.
  COALESCE(
    (i.approved_override->>'price')::numeric,
    (i.extracted->>'price')::numeric
  )                                                   AS effective_price,
  COALESCE(
    (i.approved_override->>'promo_price')::numeric,
    (i.extracted->>'promo_price')::numeric
  )                                                   AS effective_promo_price,
  COALESCE(
    NULLIF(i.approved_override->>'promo_text', ''),
    i.extracted->>'promo_text'
  )                                                   AS effective_promo_text,
  i.proposed_product_id,
  p.name                                              AS match_name,
  p.brand                                             AS match_brand,
  p.ean                                               AS match_ean,
  COALESCE(p.unit, p.format)                          AS match_quantity,
  i.confidence,
  i.method,
  i.reason,
  i.candidates,
  i.status,
  i.note,
  i.reviewed_by,
  i.reviewed_at,
  i.resulting_supermarket_product_id,
  i.resulting_snapshot_id,
  i.created_at,
  -- Search haystack (lowercase) for ilike filters from the API.
  lower(
    concat_ws(
      ' ',
      i.extracted->>'name',
      i.extracted->>'brand',
      i.extracted->>'promo_text',
      i.approved_override->>'promo_text',
      p.name,
      p.brand,
      p.ean,
      m.label,
      s.name
    )
  )                                                   AS search_text
FROM revista_review_items i
JOIN revista_magazines m ON m.id = i.magazine_id
JOIN supermarkets s      ON s.id = i.supermarket_id
LEFT JOIN products p     ON p.id = i.proposed_product_id;
