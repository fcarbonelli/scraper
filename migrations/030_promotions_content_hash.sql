-- =============================================================================
-- promotions.content_hash — change detection for snapshot deduplication.
--
-- The weekly promos run previously wrote a promotion_snapshots row for EVERY
-- promotion on EVERY run (~20k/week for Naranja X), even when nothing changed.
-- We now store a stable content hash of each promotion's meaningful fields and
-- only write a snapshot when it's NEW or CHANGED. The canonical `promotions`
-- row is still upserted in place every run (fixed-size table); only the history
-- table stops growing by 20k/week.
--
-- Idempotent: safe to re-run.
-- =============================================================================

ALTER TABLE promotions
  ADD COLUMN IF NOT EXISTS content_hash text;

COMMENT ON COLUMN promotions.content_hash IS
  'SHA-256 of the promotion''s meaningful fields (excludes timestamps). Used to '
  'skip writing a promotion_snapshots row when nothing changed since last run.';
