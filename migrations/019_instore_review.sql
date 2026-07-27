-- =============================================================================
-- In-store daily review gate (client review).
--
-- Until now an in-store submission wrote a run-less price_snapshots row at
-- submit time, so the price was IMMEDIATELY client-visible (no back-office
-- review). The client now wants to review each day's data before it reaches the
-- client base — the same idea as the online scraper's daily publish.
--
-- We mirror the REVISTA review pattern (approve-then-materialize): a submission
-- now only logs a PENDING entry; the snapshot is written when an operator
-- APPROVES it. Because a pending entry isn't a snapshot yet, the client_base
-- export excludes it automatically — no change to the export view, and
-- carry-forward keeps working (it only ever sees approved prices).
--
-- Granularity: per PDV VISIT, with inline edits allowed during approval.
--
-- Idempotent: safe to re-run.
-- =============================================================================

-- Entry review state + display name captured at scan time (so the review screen
-- can show a name even for catalog-only EANs that have no products row yet).
ALTER TABLE instore_price_entries
  ADD COLUMN IF NOT EXISTS review_status text NOT NULL DEFAULT 'pending',  -- 'pending' | 'approved' | 'rejected'
  ADD COLUMN IF NOT EXISTS reviewed_at   timestamptz,
  ADD COLUMN IF NOT EXISTS reviewed_by   text,
  ADD COLUMN IF NOT EXISTS product_name  text;

-- Backfill: entries that already materialized a snapshot (old flow) are already
-- live in the export — keep them visible by marking them approved.
UPDATE instore_price_entries
   SET review_status = 'approved'
 WHERE resulting_snapshot_id IS NOT NULL
   AND review_status = 'pending';

CREATE INDEX IF NOT EXISTS idx_instore_entries_review
  ON instore_price_entries (review_status, created_at DESC);

-- Visit review state — a separate axis from the open/finished lifecycle.
-- A visit is reviewable once status='finished'; review_status tracks the sign-off.
ALTER TABLE instore_visits
  ADD COLUMN IF NOT EXISTS review_status text NOT NULL DEFAULT 'pending',  -- 'pending' | 'approved'
  ADD COLUMN IF NOT EXISTS reviewed_at   timestamptz,
  ADD COLUMN IF NOT EXISTS reviewed_by   text;

-- Backfill: pre-existing finished visits shouldn't flood the new review queue.
UPDATE instore_visits
   SET review_status = 'approved'
 WHERE status = 'finished'
   AND review_status = 'pending';

CREATE INDEX IF NOT EXISTS idx_instore_visits_review
  ON instore_visits (review_status, status, started_at DESC);
