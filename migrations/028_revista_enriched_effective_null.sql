-- =============================================================================
-- Revista: "key present wins" for the effective promo fields.
--
-- `approved_override` records the operator's corrections. A key being PRESENT
-- means he decided that field, so `null` there means he CLEARED it. The view
-- used COALESCE, which treats a cleared promo as "nothing said" and falls back
-- to the AI read — so a promo text the reviewer deleted still showed up in
-- /revistas/aprobados (and, via the same fallback in the writer, in the client
-- Excel as Promocion_1).
--
-- `price` keeps the COALESCE on purpose: a snapshot always needs a price, so a
-- null there never means "cleared".
--
-- jsonb_exists(x, 'k') rather than `x ? 'k'`: same semantics, but `?` collides
-- with parameter placeholders in several drivers. jsonb_exists(NULL, 'k') is
-- NULL, so a row with no override falls through to the ELSE branch — the AI
-- read — which is what we want.
--
-- REBASED ON MIGRATION 020, not 017: 020 is the newest definition of this view
-- and adds carry_active, proposed_ean, the match_ean fallback and proposed_ean
-- in search_text. Only the two effective_promo_* expressions differ from it.
--
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
  m.carry_active,
  i.page_number,
  i.page_image_url,
  i.extracted,
  i.approved_override,
  -- Effective values: a key PRESENT in the override wins, null included
  -- (= the operator cleared it). `price` is the exception and still coalesces.
  COALESCE(
    (i.approved_override->>'price')::numeric,
    (i.extracted->>'price')::numeric
  )                                                   AS effective_price,
  CASE WHEN jsonb_exists(i.approved_override, 'promo_price')
       THEN (i.approved_override->>'promo_price')::numeric
       ELSE (i.extracted->>'promo_price')::numeric
  END                                                 AS effective_promo_price,
  CASE WHEN jsonb_exists(i.approved_override, 'promo_text')
       THEN NULLIF(i.approved_override->>'promo_text', '')
       ELSE NULLIF(i.extracted->>'promo_text', '')
  END                                                 AS effective_promo_text,
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
