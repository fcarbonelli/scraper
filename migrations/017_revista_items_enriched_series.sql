-- =============================================================================
-- Revista: expose series_key + superseded_by on revista_items_enriched so
-- GET /v1/revistas/items can default to current-only magazines (non-superseded)
-- and the control view can show which flyer series an approval belongs to.
--
-- Depends on migration 015 (series_key) and 014 (superseded_by).
-- Idempotent: DROP + CREATE the view.
-- =============================================================================

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
