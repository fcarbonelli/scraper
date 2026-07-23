-- =============================================================================
-- Revista: supersede previous magazines when a new issue arrives.
--
-- Bug: carry-forward re-emitted prices from magazine A after magazine B was
-- detected for the same chain, because it was mapping-based (all active
-- supermarket_products) and did not know which magazine originated a price.
--
-- Fix: when B is ingested to in_review, mark every prior magazine for that
-- chain with superseded_by = B. Carry-forward then only re-emits prices from
-- approved items on the current (non-superseded) magazine. Until B is
-- approved, those products disappear from today's export.
--
-- See docs/REVISTA_REVIEW.md § carry-forward / supersede.
-- Idempotent: safe to re-run.
-- =============================================================================

ALTER TABLE revista_magazines
  ADD COLUMN IF NOT EXISTS superseded_by uuid REFERENCES revista_magazines(id) ON DELETE SET NULL;

ALTER TABLE revista_magazines
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz;

-- Backfill: every magazine except the newest per supermarket points at the newest.
WITH ranked AS (
  SELECT
    id,
    FIRST_VALUE(id) OVER (
      PARTITION BY supermarket_id
      ORDER BY detected_at DESC, id DESC
    ) AS newest_id
  FROM revista_magazines
)
UPDATE revista_magazines m
SET
  superseded_by = ranked.newest_id,
  superseded_at = COALESCE(m.superseded_at, now())
FROM ranked
WHERE m.id = ranked.id
  AND m.id <> ranked.newest_id
  AND m.superseded_by IS NULL;

-- "Current magazine" lookup: one row per chain with superseded_by IS NULL.
CREATE INDEX IF NOT EXISTS idx_revista_mag_current
  ON revista_magazines (supermarket_id, detected_at DESC)
  WHERE superseded_by IS NULL;
