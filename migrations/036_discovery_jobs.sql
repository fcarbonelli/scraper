-- =============================================================================
-- discovery_jobs: durable record of EAN-discovery / Sunday sweep jobs.
--
-- BullMQ is the work queue and drops completed jobs. The dashboard lists
-- sweeps for weeks (GET /v1/data/discover?status=all&limit=100 filters
-- scope=sweep, and GET /v1/data/discover/weekly reads sweep_job_id), so the
-- summary has to outlive Redis.
--
-- chain_summary is the per-chain rollup ({ supermarket_id, ingested,
-- not_found, errors }[]) so a large sweep can be shown without the full
-- per-EAN result list. The result list itself stays on the BullMQ job.
--
-- Idempotent. Service-role only (RLS on, no policies for anon/authenticated).
-- =============================================================================

CREATE TABLE IF NOT EXISTS discovery_jobs (
  id             text        PRIMARY KEY,
  scope          text        NOT NULL,  -- 'ean' | 'supermarket' | 'ean_at_supermarket' | 'sweep'
  status         text        NOT NULL DEFAULT 'queued',  -- queued | running | completed | failed
  ean            text,
  supermarket_id text,
  progress       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  chain_summary  jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  failed_reason  text
);

CREATE INDEX IF NOT EXISTS idx_discovery_jobs_created
  ON discovery_jobs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_discovery_jobs_scope_created
  ON discovery_jobs (scope, created_at DESC);

ALTER TABLE discovery_jobs ENABLE ROW LEVEL SECURITY;
