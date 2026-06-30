-- =============================================================================
-- Revista (magazine) review layer.
--
-- Some chains don't publish promos on the web — only in a weekly/bi-weekly
-- magazine (a PDF or an online "flipbook"). Those are read with vision AI,
-- matched against the master catalog, and queued for HUMAN review before any
-- price reaches the client. See docs/REVISTA_REVIEW.md.
--
-- Two new tables:
--   1. revista_magazines      — one row per discovered magazine ISSUE. The
--      content_hash is the dedup key: an unchanged issue is never reprocessed
--      (zero AI cost on days the magazine didn't change).
--   2. revista_review_items   — the review queue: one row per (extracted
--      product → proposed catalog match), awaiting approve/reject.
--
-- Nothing here changes client_base: an APPROVED item just writes a normal
-- price_snapshots row (tier_used='ai', status='ok') tied to the day's run, so
-- it flows through the existing publish gate.
--
-- A "revista" supermarket is flagged via supermarkets.config:
--   config = { "source_type": "revista",
--              "revista": { "strategy": "html-pdf-links" | "pubhtml5" | "publuu",
--                           "offersUrl": "...", "pubhtml5Url": "..." } }
-- No new column on supermarkets — the orchestrator filters on config->>source_type.
--
-- Idempotent: safe to re-run.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";  -- gen_random_uuid()

-- =============================================================================
-- 1. revista_magazines — one row per discovered magazine issue
-- =============================================================================
CREATE TABLE IF NOT EXISTS revista_magazines (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  supermarket_id   text        NOT NULL REFERENCES supermarkets(id) ON DELETE CASCADE,
  label            text        NOT NULL,
  source_strategy  text        NOT NULL,                    -- 'html-pdf-links' | 'pubhtml5' | 'publuu'
  source_url       text,
  content_hash     text        NOT NULL,                    -- dedup key (URLs + sizes + page count)
  file_size        bigint,
  page_count       integer     NOT NULL DEFAULT 0,
  -- 'processing' → pipeline running; 'in_review' → queue ready for a human;
  -- 'reviewed'   → operator finished (drops out of the pending modal).
  status           text        NOT NULL DEFAULT 'processing',
  scrape_run_id    uuid        REFERENCES scrape_runs(id) ON DELETE SET NULL,
  metadata         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  detected_at      timestamptz NOT NULL DEFAULT now(),
  reviewed_at      timestamptz,
  UNIQUE (supermarket_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_revista_mag_super
  ON revista_magazines (supermarket_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_revista_mag_status
  ON revista_magazines (status, detected_at DESC);

-- =============================================================================
-- 2. revista_review_items — the human review queue
-- =============================================================================
CREATE TABLE IF NOT EXISTS revista_review_items (
  id                                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  magazine_id                       uuid        NOT NULL REFERENCES revista_magazines(id) ON DELETE CASCADE,
  supermarket_id                    text        NOT NULL REFERENCES supermarkets(id) ON DELETE CASCADE,
  page_number                       integer     NOT NULL DEFAULT 1,
  page_image_url                    text,
  -- What the AI read off the page: { name, brand, ean, price, promo_price,
  -- promo_text, quantity }.
  extracted                         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- The catalog product the AI proposes this is (NULL = manual / no proposal).
  proposed_product_id               uuid        REFERENCES products(id) ON DELETE SET NULL,
  confidence                        numeric(4,3) NOT NULL DEFAULT 0,   -- 0..1
  method                            text        NOT NULL DEFAULT 'llm', -- 'ean' | 'llm' | 'manual'
  reason                            text,
  candidates                        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  status                            text        NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected'
  note                              text,
  reviewed_by                       text,
  reviewed_at                       timestamptz,
  -- Set on approve: the mapping + snapshot the approval produced.
  resulting_supermarket_product_id  uuid        REFERENCES supermarket_products(id) ON DELETE SET NULL,
  resulting_snapshot_id             bigint,
  created_at                        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_revista_item_magazine
  ON revista_review_items (magazine_id, status);
CREATE INDEX IF NOT EXISTS idx_revista_item_pending
  ON revista_review_items (magazine_id, page_number)
  WHERE status = 'pending';
