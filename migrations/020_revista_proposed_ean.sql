-- =============================================================================
-- Revista match against Catálogo EAN: proposed_ean on review items.
--
-- Matching now indexes TAXONOMY ∪ catalog_extra_eans (not products). The queue
-- stores the official EAN; product_id is resolved on approve via
-- ensureMasterProductForEan. Legacy rows keep proposed_product_id only.
--
-- Idempotent: safe to re-run.
-- =============================================================================

ALTER TABLE revista_review_items
  ADD COLUMN IF NOT EXISTS proposed_ean text;

CREATE INDEX IF NOT EXISTS idx_revista_items_proposed_ean
  ON revista_review_items (proposed_ean)
  WHERE proposed_ean IS NOT NULL;

-- Expose proposed_ean in revista_items_enriched (extends migration 018).
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
  COALESCE(m.series_key, 'default')                   AS series_key,
  m.superseded_by,
  m.superseded_at,
  m.carry_active,
  i.page_number,
  i.page_image_url,
  i.extracted,
  i.approved_override,
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
  i.proposed_ean,
  p.name                                              AS match_name,
  p.brand                                             AS match_brand,
  COALESCE(p.ean, i.proposed_ean)                     AS match_ean,
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
      i.proposed_ean,
      m.label,
      s.name
    )
  )                                                   AS search_text
FROM revista_review_items i
JOIN revista_magazines m ON m.id = i.magazine_id
JOIN supermarkets s      ON s.id = i.supermarket_id
LEFT JOIN products p     ON p.id = i.proposed_product_id;
