# Product Management — Backend Design

> Status: **IMPLEMENTED**. This doc is the canonical design for two operator
> features. The frontend contract lives in `docs/PRODUCT_MANAGEMENT_API.md`.
> Migration: `migrations/007_catalog_extra_eans.sql`.

## The two features

1. **Remove / pause a product at a supermarket.** The "add products" screen lets
   an operator paste URLs, which get ingested. There's currently no way to *stop*
   scraping a product at one chain (e.g. a URL that's now wrong, a product we no
   longer care about at that chain). We need a per-mapping pause + a hard delete.

2. **Add a new EAN and semi-automatically discover it.** The client can hand us a
   new official product (EAN). We want to (a) register that EAN in the catalog,
   (b) auto-search it across every supermarket that supports EAN search and
   ingest it where found, and (c) fall back to the **Cobertura (coverage)** screen
   to paste URLs for the chains where it wasn't found (or that have no search).

## What already exists (reused, not rebuilt)

- `supermarket_products.is_active` — the orchestrator (`src/orchestrator/enqueue.ts`)
  **already** only enqueues `is_active = true` mappings. Pausing is a data change we
  already honor; we just lack an API to flip it.
- `DELETE /v1/products/:id` — hard-deletes a **master** product + all its mappings
  (kept as-is; different scope from per-mapping delete).
- `SupermarketAdapter.searchByEan()` — implemented by ~18 adapters; discovery relies on it.
- `getAdapterCapabilities()` → `{ hasAdapter, hasSearch }` — already surfaced on coverage.
- `scripts/discover-products.ts` — CLI discovery (per-supermarket, all EANs). We factor
  its core into a reusable module so the CLI *and* the new API share one code path.
- `GET /v1/data/coverage` — the Cobertura view. Covered vs missing per chain.
- `POST /v1/products` — single-URL ingest (host auto-detect). The manual fallback.

## Design decisions (locked)

| Decision | Choice |
|----------|--------|
| Making the EAN catalog editable | **Supplement**: keep the hardcoded `TAXONOMY_BY_EAN` (211 products) as the seed, add a small `catalog_extra_eans` DB table for runtime additions. Coverage/discovery read the **union**. |
| Discovery execution | **Async BullMQ job**. `POST` returns a `jobId`; poll a status endpoint. Discovery hits many live sites (slow, rate-limited) — well past the ~30s Caddy timeout, so it can't be synchronous. |
| Removal semantics | **Soft pause** (`is_active=false`) is the primary action (reversible, keeps price history). A separate **hard delete** removes one mapping + its snapshots for genuine mistakes. |

---

## Feature 1 — Remove / pause a mapping

### New resource: `/v1/supermarket-products/:id`

A `supermarket_products` row is the unit ("this product, at this chain"). We expose
it as a first-class resource. New route file: `src/api/routes/supermarketProducts.ts`,
mounted at `/v1/supermarket-products` in `app.ts`.

- **`PATCH /v1/supermarket-products/:id`** — body `{ is_active: boolean }`.
  Flips the pause flag. `false` → the next daily run skips it (already gated in
  `enqueue.ts`); no code change needed there. Reversible. History preserved.
- **`DELETE /v1/supermarket-products/:id`** — hard-removes this one mapping. FK
  cascade drops its `price_snapshots` and `job_executions`. The master `products`
  row and other chains' mappings are untouched. Returns counts removed.

Both confirm the row exists first (clean 404). Both log via `logger.info`.

### Listing paused mappings

`GET /v1/supermarkets/:id/products` currently hardcodes `.eq('is_active', true)`,
so paused items would vanish and couldn't be resumed from the UI. Add a
`?status=active|paused|all` query param (default `active`) and include `is_active`
in the response so the frontend can render a pause toggle and a "paused" filter.

### Coverage interaction (important)

`GET /v1/data/coverage` counts a chain's covered EANs from **active** mappings only.
A paused mapping (`is_active=false`) would silently fall back to `missing`, which is
wrong — we *have* the URL, it's just paused. Fix in the coverage query:

- Treat a product as **covered** if a mapping exists in any state.
- Add `active: boolean` to each covered product in detail mode (false when paused).
- Add a `paused` count to both summary and detail.

This keeps "covered" meaning "we have a URL for it" and makes pause visible instead
of masquerading as missing.

---

## Feature 2 — Add EAN + semi-automatic discovery

### 2a. Editable catalog

**Migration (new, e.g. `007_catalog_extra_eans.sql`):**

```sql
CREATE TABLE IF NOT EXISTS catalog_extra_eans (
  ean               text        PRIMARY KEY,
  description_forms text        NOT NULL,
  category          text,
  subcategory       text,
  brand             text,
  manufacturer      text,
  format            text,
  variety           text,
  created_by        text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
```

**New module `src/shared/catalog.ts`** (keeps `taxonomy.ts` pure/side-effect-free):

- `getCatalogEans(): Promise<Map<string, TaxonomyEntry>>` — returns the **union** of
  `TAXONOMY_BY_EAN` (hardcoded) and `catalog_extra_eans` (DB), with a short in-memory
  TTL cache (e.g. 60s) so coverage/discovery don't re-query per request.
- `lookupCatalog(ean)` — async single lookup used by ingest enrichment so a newly
  added EAN enriches correctly.

Consumers to switch from the hardcoded map to `getCatalogEans()`:
`src/api/routes/data.ts` (coverage `totalEans` + product list) and
`src/discovery/index.ts`. Ingest's `lookupTaxonomy` call becomes an async
`lookupCatalog` so extra EANs enrich too.

### Catalog endpoints (`/v1/catalog/eans`)

New route file `src/api/routes/catalog.ts`:

- **`POST /v1/catalog/eans`** — body `{ ean, descriptionForms, category?, subcategory?,
  brand?, manufacturer?, format?, variety?, auto_discover? }`. Validates EAN
  (13 digits). Upserts into `catalog_extra_eans` (idempotent). If `auto_discover:true`,
  immediately enqueues a discovery job for that EAN (returns its `jobId`).
  Rejects EANs already present in the hardcoded taxonomy (already official).
- **`GET /v1/catalog/eans`** — lists the runtime-added extra EANs.
- **`DELETE /v1/catalog/eans/:ean`** — removes an extra EAN (hardcoded ones are
  immutable → 400). Does **not** delete already-ingested mappings/snapshots.

### 2b. Discovery as an async job

**Reusable core — `src/discovery/index.ts`** (extracted from the CLI script):

```ts
// One EAN at one chain: search → ingest if found. No throw on "not found".
discoverEanAtSupermarket(ean, supermarketId): Promise<DiscoverOutcome>
// One EAN across every chain whose adapter has searchByEan (Feature 2 main path).
discoverEanEverywhere(ean): Promise<DiscoverOutcome[]>
// One chain, all catalog EANs (today's CLI behavior, now callable from the API).
discoverAllEansAtSupermarket(supermarketId): Promise<DiscoverOutcome[]>
```

`DiscoverOutcome = { ean, supermarketId, result: 'ingested'|'existed'|'not_found'|'no_search'|'error', url?, error? }`.
Ingest is called with `runInitialScrape:false, preResolvedExternalId` (same as the CLI)
so found products register fast and get priced on the next scheduled run.
`scripts/discover-products.ts` is refactored to import this module (no behavior change).

**New BullMQ queue `discovery`** (`src/shared/queue.ts` + a processor in
`src/worker/`). Job payload is one of the three scopes:

```ts
type DiscoveryJobData =
  | { scope: 'ean';               ean: string }                       // all chains
  | { scope: 'supermarket';       supermarketId: string }             // all EANs
  | { scope: 'ean_at_supermarket'; ean: string; supermarketId: string };
```

The processor expands the scope into targets, iterates them (respecting per-adapter
politeness delays), calls the discovery core, and reports progress via
`job.updateProgress({ total, done, found, ingested, notFound, errors })`. The final
`returnvalue` holds the per-target results array.

### Weekly coverage sweep

Products go missing at a chain when they're temporarily out of stock / delisted;
we may never have found them manually. A **weekly sweep** re-searches only the
**missing** `(EAN × searchable chain)` pairs so returning products get picked up
automatically.

- **Scope `sweep`** on the discovery queue. The worker (`runSweep` in
  `src/worker/discoveryWorker.ts`) loads active supermarkets, intersects with
  `adaptersWithSearch()`, and for each computes `missingEansForSupermarket()`
  (catalog − covered, where **covered includes paused** so a paused product is
  never resurrected). It searches only those, auto-ingesting matches (EAN-bound,
  so no orphan masters), then sends a **Telegram summary** of what it added.
- **Cron**: `env.SWEEP_CRON` (default `0 2 * * 0` — Sunday 02:00 BA time),
  scheduled in `src/orchestrator/index.ts`. It just enqueues one `sweep` job.
- **Manual triggers**: `POST /v1/data/discover { "sweep": true }`, or
  `node dist/orchestrator/index.js --sweep-now`.
- **No not-found cache** (by decision): every missing pair is re-searched each
  week. Cost shrinks as coverage grows; add a `last_searched` table later only if
  it becomes a problem.

Cost: ≤ `catalogSize × searchableChains` searches, minus covered — the missing
subset only, at ~1.5s politeness. Runs as one job (discovery worker), off-peak.

### Discovery endpoints (`/v1/data/discover`)

- **`POST /v1/data/discover`** — body one of `{ ean }`, `{ supermarket }`, or
  `{ ean, supermarket }`. Enqueues a `discovery` job. Returns
  `{ jobId, scope, targets, status: 'queued' }` (201). `targets` lets the UI show
  "searching N chains".
- **`GET /v1/data/discover/:jobId`** — reads `queue.getJob(jobId)`; returns
  `{ jobId, status, progress, results }`. `status ∈ queued|running|completed|failed`.

No new table for job state — BullMQ job progress + returnvalue is enough. (A
`discovery_runs` audit table is possible later; not needed for v1.)

### The intended operator flow

1. Operator adds a new official EAN in the **Catalog** screen → `POST /v1/catalog/eans`
   (optionally `auto_discover:true`).
2. Discovery job fans out `searchByEan` across every `hasSearch` chain, auto-ingesting
   matches. Coverage flips those chains to **covered** automatically.
3. Chains where the EAN wasn't found (or `hasSearch:false`) stay **missing** in the
   **Cobertura** detail view — the operator's shopping list. They paste a URL there
   via the existing add flow (see the EAN-binding note below).

### Healing existing EAN-less products (backfill + merge)

Products ingested from EAN-less sites *before* the `ean` binding existed sit as
orphan masters (`ean = NULL`, no taxonomy) and export with blank general columns.
`src/ingest/bindEan.ts` `bindMappingToEan(smpId, ean)` heals them:

1. Find (or promote-in-place / create) the **canonical** master for the EAN.
2. Re-point the mapping's `product_id` to it. **Snapshots key on the mapping**, so
   the price series is preserved with no snapshot migration.
3. Enrich the canonical master's general columns from the catalog taxonomy.
4. Delete the old master if it has no remaining mappings.

Exposed at **`PATCH /v1/supermarket-products/:id { ean }`**. The heal worklist is
**`GET /v1/products/missing-ean`** (masters with `ean IS NULL` + their mappings).

**Suggestion engine** (`src/discovery/eanMatch.ts`): ranks candidate EANs for an
orphan by name/brand token overlap against (a) the catalog taxonomy and (b) the
scraped names of sibling products that already carry each EAN — the sibling names
are the strongest signal. Each suggestion gets a `score` (0..1) and a `confidence`
(`high` = score ≥ 0.7 with a clear margin; `medium` ≥ 0.45; else `low`). Cached
5 min. Shared by the CLI **and** `GET /v1/products/missing-ean` (which returns
`suggestions[]` per row + a `?min_confidence=` filter) so a frontend can offer
one-click confirm. Swappable for the embeddings/LLM matcher in `src/revistas/match.ts`
behind the same interface if token overlap proves too weak.

Two matcher refinements matter: **placeholder names** ("Unknown product" — legacy
failed-parse rows) are excluded from the index (they'd otherwise make every no-name
orphan match at 1.0), and when an orphan's name is a placeholder the **URL slug** is
used as the signal instead (e.g. `.../lavandina-odex-comun-4-lt` is matchable even
with no name). Opaque URLs with no slug (MercadoLibre `/p/MLA…`) stay unmatchable —
those need a re-scrape to recover the EAN, not fuzzy matching.

**LLM judge** (`src/discovery/eanJudge.ts`): for the ambiguous medium/low band, an
LLM (reuses `REVISTA_JUDGE_MODEL` + `OPENAI_API_KEY`) adjudicates each orphan against
its top candidates — confirming the clear ones and rejecting wrong size/variant
matches. Batched; degrades gracefully to `llm-none` if the key is missing.

**One-time backlog cleanup** (`scripts/heal-eans.ts`). Because PowerShell swallows the
`--` in `npm run heal:eans -- <flags>`, invoke it directly:
`npx tsx --env-file=.env scripts/heal-eans.ts <flags>` (the `npm run heal:eans` alias
still works for the no-flag report, and `npm run … -- <flags>` works on bash/CI).

- Report + CSV (high rows pre-filled in `confirm_ean`): no flags.
- `--judge` — LLM-adjudicate the not-high band; pre-fills high + LLM-confirmed rows.
- `--apply=<csv>` — bind a curated CSV via `bindMappingToEan`.
- `--auto` — bind high-confidence with no CSV; `--judge --auto` binds high + LLM-confirmed.
- Tuning: `--auto-confidence=medium`, `--auto --min-score=N`, `--judge-threshold=0.7`, `--limit=N`.

We can't fully automate blind because we never stored which catalog EAN each pasted
URL was for — hence confidence + judge + a confirm step for the genuinely ambiguous tail.
Because the master is one-per-EAN and shared across chains, once the EAN is set
*every* chain's rows inherit the same taxonomy — no cross-supermarket copying is
needed. (Discovery-ingested products are already EAN-bound; the daily scrape never
creates orphans.)

### Manual-add EAN binding (gotcha)

When adding a URL from a *missing* coverage cell, ingest dedupes the master product by
the EAN it can *probe* off the page. Chains that don't expose an EAN (e.g. Coto,
`hasSearch:false`) would create a master row **without** the catalog EAN → the product
still shows as missing. To make manual coverage adds reliable, extend
`POST /v1/products` with an optional `{ ean }` that binds the ingested mapping to the
known catalog master product regardless of what the page exposes. (This dovetails with
the existing "coverage confirmations" design in `docs/COVERAGE_CONFIRMATIONS_API.md`.)

---

## Files touched (as built)

- `migrations/007_catalog_extra_eans.sql` — new table.
- `src/shared/catalog.ts` — union catalog loader with TTL cache (new).
- `src/shared/queue.ts` — `discovery` queue (`getDiscoveryQueue`) + `DiscoveryJobData`.
- `src/discovery/index.ts` — reusable discovery core (new).
- `src/worker/discoveryWorker.ts` — discovery job processor (new); registered in
  `src/worker/index.ts`.
- `scripts/discover-products.ts` — refactored to use `src/discovery` (adds `--ean=`).
- `src/api/routes/supermarketProducts.ts` — `PATCH /:id` (pause) + `DELETE /:id`.
- `src/api/routes/catalog.ts` — catalog CRUD (new), mounted at `/v1/catalog`.
- `src/api/routes/data.ts` — `/discover` + `/discover/:jobId`; coverage now reads the
  union catalog and is pause-aware (`paused` count, per-product `active`).
- `src/api/routes/supermarkets.ts` — `?status=active|paused|all` + `is_active` in rows.
- `src/api/routes/products.ts` — optional `{ ean }` on `POST /v1/products`.
- `src/ingest/index.ts` — accepts a forced `ean`; enriches via `lookupCatalog`.
- `src/api/app.ts` — mounts the catalog router (`supermarket-products` already mounted).

### Operational note

The discovery worker runs inside the **worker** process (`pm2` `worker`). Deploying
this change requires the worker to restart (CI `pm2 reload` covers it). The migration
`007` must be run in Supabase before `POST /v1/catalog/eans` will work.
