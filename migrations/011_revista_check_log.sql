-- =============================================================================
-- Revista check log — observability for the daily "did any magazine change?"
-- probe. (Migration 011; 009/010 are the in-store layer.)
--
-- The revista pipeline checks each magazine-sourced chain every day, but on most
-- days nothing changed (issues update every 1–2 weeks) so NO magazine row is
-- created — leaving the operator with no evidence the check even ran. This table
-- records ONE row per (chain, check), whether or not a new issue was found, so a
-- frontend can show "Makro — checked 09:00, no change" every day.
--
-- One row per site per daily check. Cheap, append-only, no dedup.
--
-- Idempotent: safe to re-run.
-- =============================================================================

CREATE TABLE IF NOT EXISTS revista_check_log (
  id             bigserial PRIMARY KEY,
  supermarket_id text        NOT NULL REFERENCES supermarkets(id),
  strategy       text,                                   -- 'html-pdf-links' | 'pubhtml5' | 'publuu'
  checked_at     timestamptz NOT NULL DEFAULT now(),
  outcome        text        NOT NULL,                   -- 'no_change' | 'new_issue' | 'error'
  candidates     integer     NOT NULL DEFAULT 0,         -- issues discovered on the site
  new_issues     integer     NOT NULL DEFAULT 0,         -- newly processed this check
  duration_ms    integer,                                -- how long the check took
  detail         text,                                   -- error message / short summary
  scrape_run_id  uuid        REFERENCES scrape_runs(id)  -- the run this check belonged to (nullable)
);

-- Feed ordering + "latest per site" lookups.
CREATE INDEX IF NOT EXISTS idx_revista_check_log_checked_at
  ON revista_check_log (checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_revista_check_log_super
  ON revista_check_log (supermarket_id, checked_at DESC);
