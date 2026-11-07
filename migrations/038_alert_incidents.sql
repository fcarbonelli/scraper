-- =============================================================================
-- 038: alerts become deduplicated incidents
--
-- Until now every evaluation inserted a fresh `alerts` row and pinged Telegram,
-- and nothing ever closed them: 12k+ rows sat in status='open', mostly the
-- same chronic per-chain failure rates re-reported every morning.
--
-- An incident is identified by `fingerprint` (e.g. 'scrape:vea'). While one is
-- open/acknowledged, re-detections only bump `occurrences` + `last_seen_at`
-- and refresh `evidence` — no new row, no new Telegram message. The finalizer
-- resolves it automatically once a later run looks healthy.
--
-- `evidence` holds what an operator (or an agent) needs to start fixing:
-- error-type counts, sample failing URLs + messages, job_execution ids.
-- =============================================================================

ALTER TABLE alerts
  ADD COLUMN IF NOT EXISTS fingerprint  text,
  ADD COLUMN IF NOT EXISTS occurrences  integer     NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS evidence     jsonb       NOT NULL DEFAULT '{}'::jsonb;

UPDATE alerts SET last_seen_at = created_at;

-- At most one live incident per fingerprint.
CREATE UNIQUE INDEX IF NOT EXISTS uq_alerts_live_fingerprint
  ON alerts (fingerprint)
  WHERE fingerprint IS NOT NULL AND status IN ('open', 'acknowledged');

-- Close the backlog of legacy per-run scrape alerts. Revista alerts are left
-- alone: the review UI reads `revista_review` rows and the health probes
-- already dedupe on status.
UPDATE alerts
SET status = 'resolved', resolved_at = now()
WHERE status IN ('open', 'acknowledged')
  AND type IN (
    'supermarket_unstable',
    'supermarket_degraded',
    'selector_broken',
    'rate_limited',
    'auth_required'
  );
