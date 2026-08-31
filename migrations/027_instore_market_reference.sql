-- =============================================================================
-- In-store "reference price" for the typo warning.
--
-- The field app (in-store price entry) warns when a typed price deviates ±35%
-- from the product's recent MARKET price. That market price normally lives in
-- the pricing endpoints (client_base), but the field app's API key is scoped to
-- /v1/in-store/* and can't reach them — so the reference has to be served from
-- an in-store endpoint (GET /v1/in-store/lookup and /catalog). This function is
-- the efficient, DB-side aggregation behind it.
--
-- Definition: for each requested EAN, take the LATEST online price at each store
-- within a recent window, then the MEDIAN across stores. Latest-per-store first
-- (instead of pooling every daily row) so a chain that scrapes more often does
-- not dominate the median; the median across stores is then robust to a single
-- store's outlier. Only real, positive `ok` prices count.
--
-- Read-only + STABLE (safe to call from a read path). Wholesale-only EANs never
-- scraped online return no row here; the API layer falls back to recent in-store
-- entries and then the EDP target for those.
--
-- Idempotent: safe to re-run.
-- =============================================================================

CREATE OR REPLACE FUNCTION instore_market_reference(
  p_eans  text[],
  p_since timestamptz
)
RETURNS TABLE(ean text, reference_price numeric, sample_size integer)
LANGUAGE sql
STABLE
AS $$
  WITH latest_per_store AS (
    -- One representative (most recent) price per store for each EAN in-window.
    SELECT DISTINCT ON (p.ean, sp.supermarket_id)
           p.ean    AS ean,
           ps.price AS price
    FROM price_snapshots ps
    JOIN supermarket_products sp ON sp.id = ps.supermarket_product_id
    JOIN products p              ON p.id  = sp.product_id
    WHERE p.ean = ANY(p_eans)
      AND ps.scraped_at >= p_since
      AND ps.status = 'ok'
      AND ps.price > 0
    ORDER BY p.ean, sp.supermarket_id, ps.scraped_at DESC
  )
  SELECT ean,
         round(percentile_cont(0.5) WITHIN GROUP (ORDER BY price)::numeric, 2) AS reference_price,
         COUNT(*)::int                                                          AS sample_size
  FROM latest_per_store
  GROUP BY ean;
$$;
