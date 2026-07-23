-- =============================================================================
-- Revista: series_key — supersede / carry-forward per flyer SERIES, not chain.
--
-- Bug: Makro/Vital publish several concurrent flyer series (MM weekly, GT
-- gastronomic, Folder, Nonfood, …). Migration 014 superseded by supermarket_id
-- alone, so processing series B the same day marked series A as superseded and
-- carry-forward only re-emitted one magazine → other series' prices vanished.
--
-- Fix: each magazine belongs to a series_key. Supersede and carry-forward scope
-- to (supermarket_id, series_key). Rosental/Maxicomodín use 'default'.
--
-- See docs/REVISTA_REVIEW.md § carry-forward / series.
-- Idempotent: safe to re-run.
-- =============================================================================

ALTER TABLE revista_magazines
  ADD COLUMN IF NOT EXISTS series_key text;

-- Best-effort backfill from existing labels/filenames before NOT NULL default.
-- Makro-style tokens in the PDF filename.
UPDATE revista_magazines
SET series_key = CASE
  WHEN lower(label) ~ '(^|[^a-z])mm([^a-z]|$)|ofertas semanales' THEN 'mm'
  WHEN lower(label) ~ '(^|[^a-z])gt([^a-z]|$)|gastronom' THEN 'gt'
  WHEN lower(label) ~ 'sponsor|ofertas especiales' THEN 'sponsor'
  WHEN lower(label) ~ 'makronet|neta' THEN 'makroneta'
  WHEN lower(label) ~ 'especial|dia.?del.?amigo' THEN 'especial'
  -- Vital-style human labels (when label was already the data-name)
  WHEN lower(label) ~ 'folder nonfood' THEN 'folder-nonfood'
  WHEN lower(label) ~ '^folder|folder ' THEN 'folder'
  WHEN lower(label) ~ 'especial frescos|frescos' THEN 'especial-frescos'
  WHEN lower(label) ~ 'marca propia' THEN 'aviso-marca-propia'
  WHEN lower(label) ~ 'pa[nñ]ales' THEN 'aviso-panales'
  WHEN lower(label) ~ 'solo por jueves|jueves' THEN 'aviso-jueves'
  ELSE 'default'
END
WHERE series_key IS NULL OR series_key = '';

ALTER TABLE revista_magazines
  ALTER COLUMN series_key SET DEFAULT 'default';

UPDATE revista_magazines
SET series_key = 'default'
WHERE series_key IS NULL OR series_key = '';

-- Re-supersede within each series: only the newest per (supermarket, series)
-- stays current. Clears prior chain-wide supersede from migration 014 first.
UPDATE revista_magazines
SET superseded_by = NULL, superseded_at = NULL;

WITH ranked AS (
  SELECT
    id,
    FIRST_VALUE(id) OVER (
      PARTITION BY supermarket_id, COALESCE(series_key, 'default')
      ORDER BY detected_at DESC, id DESC
    ) AS newest_id
  FROM revista_magazines
)
UPDATE revista_magazines m
SET
  superseded_by = ranked.newest_id,
  superseded_at = now()
FROM ranked
WHERE m.id = ranked.id
  AND m.id <> ranked.newest_id;

DROP INDEX IF EXISTS idx_revista_mag_current;

-- Current magazine lookup: one row per (chain, series) with superseded_by IS NULL.
CREATE INDEX IF NOT EXISTS idx_revista_mag_current_series
  ON revista_magazines (supermarket_id, series_key, detected_at DESC)
  WHERE superseded_by IS NULL;
