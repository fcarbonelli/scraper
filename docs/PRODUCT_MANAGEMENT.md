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
