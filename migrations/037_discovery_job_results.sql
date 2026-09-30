-- =============================================================================
-- discovery_jobs.results: the per-EAN list of a sweep.
--
-- chain_summary is only counts. The Barrido view needs the EANs that were
-- actually searched, and Redis drops the BullMQ return value. This column
-- keeps that list with the job row.
--
-- Idempotent. Service-role only, same as the parent table.
-- =============================================================================

ALTER TABLE discovery_jobs
  ADD COLUMN IF NOT EXISTS results jsonb;
