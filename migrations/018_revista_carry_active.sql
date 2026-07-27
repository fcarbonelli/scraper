-- =============================================================================
-- Revista: carry_active — interruptor manual por revista.
--
-- Permite bajar/subir de la base del cliente TODOS los productos aprobados de un
-- folleto de un solo clic, sin tener que desaprobar producto por producto (p. ej.
-- un folleto con muchos errores de lectura de la IA, o uno que queremos dejar
-- atras por vencimiento mientras todavia no implementamos las ventanas de fecha).
--
-- Semantica:
--   carry_active = true  (default) -> el folleto participa del carry-forward
--                                     diario y sus aprobados aparecen en la base.
--   carry_active = false           -> el carry-forward lo ignora; ademas al
--                                     desactivar se purga el snapshot de HOY y se
--                                     pausan sus mappings (que no sostenga otra
--                                     revista activa) para que caiga de la base al
--                                     instante. Reversible: reactivar re-emite hoy.
--
-- Es ORTOGONAL a superseded_by (corte automatico por edicion nueva) y a las
-- futuras ventanas de fecha. Un folleto puede estar vigente (no superseded) pero
-- carry_active=false.
--
-- Idempotente: safe to re-run.
-- =============================================================================

ALTER TABLE revista_magazines
  ADD COLUMN IF NOT EXISTS carry_active boolean NOT NULL DEFAULT true;

-- Lookup del carry-forward: revistas vigentes Y activas por (chain, serie).
DROP INDEX IF EXISTS idx_revista_mag_current_active;
CREATE INDEX IF NOT EXISTS idx_revista_mag_current_active
  ON revista_magazines (supermarket_id, series_key, detected_at DESC)
  WHERE superseded_by IS NULL AND carry_active = true;

-- =============================================================================
-- Exponer carry_active en revista_items_enriched (extiende la vista de
-- migration 017). DROP + CREATE reproduciendo la definicion completa.
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
