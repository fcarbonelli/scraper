-- =============================================================================
-- In-store manual price entry layer.
--
-- Some (mostly wholesale / "mayorista") chains don't publish prices online at
-- all — a person physically visits the store, scans the product barcode (EAN),
-- and types the shelf price into a mobile web tool. Those entries are trusted
-- (the operator on-site IS the gate), so — exactly like the revista pipeline —
-- they write RUN-LESS price_snapshots (scrape_run_id = null, always
-- client-visible) and are re-emitted daily by carryForwardInStorePrices() so
-- the price persists in the client export until a newer entry supersedes it.
--
-- This migration adds:
--   1. api_keys.scopes   — optional per-key route scoping. NULL/empty = full
--      access (every existing key keeps working). A key scoped to {'in-store'}
--      can ONLY reach /v1/in-store/* routes, so the credential embedded in the
--      public mobile app has a tiny blast radius if it leaks.
--   2. instore_price_entries — an audit log of every submission (who, which
--      store, EAN, price, promo, resulting mapping + snapshot). Powers the
--      "today's entries" list in the UI and operator review.
--
-- No new column on supermarkets: an in-store chain is flagged via config, same
-- pattern as revista —
--   config = { "source_type": "instore", "instore": { "enabled": true } }
-- Web-scraped or revista chains that ALSO want in-store entry just add
--   config.instore = { "enabled": true }
-- (keeping their existing source_type). The in-store dropdown lists every chain
-- with config.instore.enabled = true.
--
-- Idempotent: safe to re-run.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";  -- gen_random_uuid()

-- =============================================================================
-- 1. api_keys.scopes — optional route scoping for embedded/public keys
-- =============================================================================
ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS scopes text[];

COMMENT ON COLUMN api_keys.scopes IS
  'Optional route scopes. NULL/empty = full API access. When set (e.g. '
  '{in-store}), the key may only reach routes tagged with a matching scope.';

-- =============================================================================
-- 2. instore_price_entries — audit log of every in-store submission
-- =============================================================================
CREATE TABLE IF NOT EXISTS instore_price_entries (
  id                                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  supermarket_id                    text          NOT NULL REFERENCES supermarkets(id) ON DELETE CASCADE,
  -- The scanned barcode and the catalog product it resolved to.
  ean                               text          NOT NULL,
  product_id                        uuid          REFERENCES products(id) ON DELETE SET NULL,
  -- What the submission produced (the mapping + snapshot rows).
  resulting_supermarket_product_id  uuid          REFERENCES supermarket_products(id) ON DELETE SET NULL,
  resulting_snapshot_id             bigint,
  -- Prices as entered by the operator. `price` is the regular/shelf price;
  -- promo_price/promo_text are set only when there's an offer.
  price                             numeric(12,2) NOT NULL,
  list_price                        numeric(12,2),
  promo_price                       numeric(12,2),
  promo_text                        text,
  -- Attribution: the free-text name the field worker typed (saved in their
  -- browser and sent with every submission) + which embedded key was used.
  entered_by                        text          NOT NULL,
  api_key_id                        uuid          REFERENCES api_keys(id) ON DELETE SET NULL,
  note                              text,
  created_at                        timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_instore_entries_super
  ON instore_price_entries (supermarket_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_instore_entries_ean
  ON instore_price_entries (ean);
CREATE INDEX IF NOT EXISTS idx_instore_entries_created
  ON instore_price_entries (created_at DESC);
