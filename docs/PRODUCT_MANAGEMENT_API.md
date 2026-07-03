# Product Management API — Frontend Integration Guide

> Status: **LIVE** (pending deploy + migration 007). Backend design:
> `docs/PRODUCT_MANAGEMENT.md`. Shapes below follow the standard envelope
> (`{ data, meta }` on success, `{ error }` on failure) used by every `/v1` route.

## Authentication

Same as every `/v1` endpoint: pass the API key in the `X-API-Key` header.

## What you can build with this

1. **Pause / remove** a product at a specific supermarket (from the per-supermarket
   product list). — Part 1
2. **Add a new EAN** to the catalog and **auto-discover** it across all searchable
   supermarkets, then fill the gaps from the **Cobertura** (coverage) screen. — Part 2
3. **Heal EAN-less products** so the client export stops showing blank
   `EAN`/`Categoria`/`Marca` columns, and **prevent** new ones. — Part 3

### Frontend feature checklist (what to wire, and why)

| Screen / action | Endpoint(s) | Why |
|---|---|---|
| Per-supermarket product list with pause/resume + delete | `GET /v1/supermarkets/:id/products?status=`, `PATCH`/`DELETE /v1/supermarket-products/:id` | Stop scraping products no longer sold / bad URLs |
| Add product URL (**must send `ean` when adding from a coverage "missing" cell**) | `POST /v1/products` | Prevents new EAN-less orphans (see Part 3) |
| Catalog EAN management (add/list/remove official EANs) | `GET/POST/DELETE /v1/catalog/eans` | Extend the catalog at runtime |
| Cobertura (coverage) grid with `covered / paused / missing` | `GET /v1/data/coverage` | See gaps; drive discovery + manual adds |
| Discovery trigger + progress | `POST /v1/data/discover`, `GET /v1/data/discover/:jobId` | Auto-find a new EAN across chains |
| **Missing-EAN heal screen** | `GET /v1/products/missing-ean`, `PATCH /v1/supermarket-products/:id { ean }` | Fix blank export columns on EAN-less products |

> **The existing backlog is healed once from the backend CLI** (`npm run heal:eans`,
> see Part 3) — the frontend does **not** need a bulk-heal tool. The Missing-EAN
> screen is for ongoing one-offs and for verifying the backlog reached zero.

---

# Part 1 — Pausing & removing products

A product-at-a-supermarket is identified by its `supermarket_product_id` (already
returned by `GET /v1/supermarkets/:id/products`, `GET /v1/products/:id/compare`, etc.).

## `PATCH /v1/supermarket-products/:id` — pause / resume

The primary "stop scraping this" action. Reversible; price history is kept. A paused
mapping is skipped by the daily run until resumed.

**Request:**
```
PATCH /v1/supermarket-products/6f1c...  →  { "is_active": false }
X-API-Key: <key>
```

**Response:**
```json
{
  "data": {
    "id": "6f1c...",
    "supermarket_id": "carrefour",
    "product_id": "a12b...",
    "external_url": "https://www.carrefour.com.ar/....../p",
    "is_active": false
  },
  "meta": { "ts": "2026-07-01T..." }
}
```

Resume by sending `{ "is_active": true }`.

## `DELETE /v1/supermarket-products/:id` — hard remove (one chain)

For genuine mistakes (wrong URL, junk row). Deletes this **one** mapping and its
price history. The master product and other chains are untouched. Prefer **pause**
unless the operator is sure.

**Response:**
```json
{
  "data": {
    "id": "6f1c...",
    "deleted": true,
    "removed": { "price_snapshots": 128, "job_executions": 130 }
  },
  "meta": { "ts": "2026-07-01T..." }
}
```

> To remove a product from **every** supermarket at once, use the existing
> `DELETE /v1/products/:id` (deletes the master + all mappings).

## Listing paused items — `GET /v1/supermarkets/:id/products?status=...`

The per-supermarket product list gains a `status` filter and an `is_active` field:

- `?status=active` (default) — currently-scraped products.
- `?status=paused` — the "resume list".
- `?status=all` — everything.

Each row now includes `is_active`, so you can render a toggle inline:

```json
{
  "data": [
    {
      "supermarket_product_id": "6f1c...",
      "external_id": "12345",
      "external_url": "https://www.carrefour.com.ar/....../p",
      "is_active": true,
      "product": { "id": "a12b...", "name": "Lavandina ...", "ean": "779..." },
      "latest_snapshot": { "price": 1990, "in_stock": true, "scraped_at": "..." }
    }
  ],
  "meta": { "pagination": { "page": 1, "limit": 50, "total": 164 } }
}
```

### Suggested UI (product list)

Add an **Actions** column per row:
- A **Pause / Resume** switch bound to `is_active` (calls `PATCH`).
- A **Remove** (trash) button (calls `DELETE`, with a confirm dialog explaining it
  wipes that chain's price history for this product).
- A `status` dropdown filter (Active / Paused / All). Show paused rows greyed out.

---

# Part 2 — Adding a new EAN & discovering it

## `POST /v1/catalog/eans` — register a new official EAN

Adds an EAN to the catalog so it starts appearing in the Cobertura view and can be
discovered. Idempotent (re-posting the same EAN updates its fields).

**Request:**
```
POST /v1/catalog/eans
X-API-Key: <key>
{
  "ean": "7791234567890",
  "descriptionForms": "LAVANDINA NUEVA 1L",
  "category": "LAVANDINAS",
  "subcategory": "REG",
  "brand": "AYUDIN",
  "manufacturer": "GRUPO AYUDIN",
  "format": "1000",
  "variety": "REG",
  "auto_discover": true
}
```

Only `ean` and `descriptionForms` are required. `auto_discover` (default `false`)
kicks off discovery immediately and returns its `jobId`.

**Response (201):**
```json
{
  "data": {
    "ean": "7791234567890",
    "descriptionForms": "LAVANDINA NUEVA 1L",
    "category": "LAVANDINAS",
    "discovery": { "jobId": "disc_8f2...", "status": "queued", "targets": 18 }
  },
  "meta": { "ts": "2026-07-01T..." }
}
```

`discovery` is present only when `auto_discover: true`. Errors:
- `400` if the EAN isn't 13 digits, or is already part of the built-in catalog.

## `GET /v1/catalog/eans` — list runtime-added EANs

Returns the extra EANs added via the API (the built-in 211 are not listed here).

## `DELETE /v1/catalog/eans/:ean` — remove an extra EAN

Removes a runtime-added EAN from the catalog. Built-in EANs return `400`. Already
ingested mappings/snapshots are **not** deleted (use Part 1 for those).

---

## `POST /v1/data/discover` — run discovery (async)

Discovery searches supermarket sites live, so it runs as a background job. You get a
`jobId` back immediately and poll for progress. Three scopes:

| Body | Meaning | Use case |
|------|---------|----------|
| `{ "ean": "779..." }` | Search this EAN at **every** chain with `hasSearch` | The main "I just added an EAN" flow |
| `{ "supermarket": "carrefour" }` | Search **all** catalog EANs at one chain | Backfill a newly-added supermarket |
| `{ "ean": "779...", "supermarket": "carrefour" }` | One EAN at one chain | Retry a single cell |
| `{ "sweep": true }` | Re-search **missing** EANs at every searchable chain | Manually run the weekly coverage sweep |

> **Weekly coverage sweep (automatic):** a cron (default Sunday 02:00 BA time)
> fires `{ sweep: true }` automatically — it re-searches only the *missing*
> `(EAN × chain)` pairs so products that were out of stock reappear in coverage,
> and posts a Telegram summary of what it added. Paused products are never
> resurrected. You can also trigger it on demand with the body above; poll it via
> `GET /v1/data/discover/:jobId` like any other discovery job.

**Response (201):**
```json
{
  "data": {
    "jobId": "disc_8f2...",
    "scope": "ean",
    "targets": ["carrefour", "vea", "jumbo", "disco", "..."],
    "status": "queued"
  },
  "meta": { "ts": "2026-07-01T..." }
}
```

`targets` is the list of supermarkets that will actually be searched (only those with
`hasSearch: true` — see the `hasSearch` flag on `GET /v1/data/coverage`).

## `GET /v1/data/discover/:jobId` — poll progress

Poll every ~2s while `status` is `queued` or `running`.

**Response:**
```json
{
  "data": {
    "jobId": "disc_8f2...",
    "status": "running",
    "progress": { "total": 18, "done": 11, "found": 6, "ingested": 6, "notFound": 5, "errors": 0 },
    "results": [
      { "ean": "779...", "supermarketId": "carrefour", "result": "ingested",
        "url": "https://www.carrefour.com.ar/....../p" },
      { "ean": "779...", "supermarketId": "coto", "result": "no_search" },
      { "ean": "779...", "supermarketId": "vea", "result": "not_found" }
    ]
  },
  "meta": { "ts": "2026-07-01T..." }
}
```

`status`: `queued` → `running` → `completed` (or `failed`).
Per-target `result`: `ingested` (added), `existed` (already had it), `not_found`
(searched, absent), `no_search` (chain has no EAN search — needs a manual URL),
`error`.

When the job completes, the **Cobertura** view for those chains reflects the new
`covered` products automatically — no extra call needed.

---

# Part 3 — Healing EAN-less products (fixing blank export columns)

**The problem:** products added from EAN-less sites (e.g. Coto) without an EAN
create a master row with no EAN and no taxonomy. They export with blank
`Categoria` / `Marca` / `EAN` / … and never dedupe with the "real" master that
EAN-exposing chains created for the same product.

**The fix:** bind the correct catalog EAN to the mapping. The backend re-points
it to the canonical master for that EAN, fills the general columns from the
catalog taxonomy, and drops the orphan blank master. **Price history is
preserved** (snapshots key on the mapping, not the master).

> Prevention: always send `ean` on `POST /v1/products` when adding from a
> "missing" coverage cell (see below). Healing is for rows added before that.

### Two parts: one-time backlog vs. prevention

- **Backlog (existing NULL-EAN products):** healed **once** from the backend CLI
  (`npx tsx --env-file=.env scripts/heal-eans.ts <flags>`). It ranks each orphan against
  the catalog + sibling names (using the URL slug when the name is missing) and tags a
  confidence; `--judge` adds an LLM pass that adjudicates the ambiguous band. Fastest
  path: `… scripts/heal-eans.ts --judge --auto` binds every high + LLM-confirmed match
  and leaves only the genuinely unmatchable (e.g. MercadoLibre `/p/MLA…`, which need a
  re-scrape). See `docs/PRODUCT_MANAGEMENT.md`. **No frontend work needed for this.**
- **Prevention (going forward):** the **Add product** screen must pass `ean` when the
  URL is being added for a known coverage cell, so no new orphans appear. The
  Missing-EAN screen below stays as a safety net for one-offs.

## `GET /v1/products/missing-ean` — the heal worklist (with suggestions)

Master products with no EAN, each with its supermarket mappings **and ranked EAN
`suggestions` (candidate EAN + score + confidence)** so the UI can offer one-click
"confirm this match" instead of manual typing. Paginated (`page`, `limit`).

**Query:** `?min_confidence=high|medium|low` (default `low`) — filters to rows whose
top suggestion is at least that confident. Use `high` to build a "review the easy
wins first" queue.

```json
{
  "data": [
    {
      "id": "a12b...",
      "name": "Lavandina en Gel Ayudín 1L",
      "brand": "Ayudín",
      "category": null,
      "mappings": [
        { "id": "6f1c...", "supermarket_id": "coto",
          "external_url": "https://www.cotodigital.com.ar/...", "is_active": true }
      ],
      "suggestions": [
        { "ean": "7791234567890", "score": 0.83, "confidence": "high",
          "description": "Lavandina en gel Ayudín 1 L" },
        { "ean": "7790000000001", "score": 0.41, "confidence": "medium",
          "description": "Lavandina Ayudín 1 L" }
      ]
    }
  ],
  "pagination": { "page": 1, "limit": 50, "total": 37 },
  "meta": { "ts": "..." }
}
```

- `confidence`: `high` (score ≥ 0.7 **and** a clear margin over #2), `medium` (≥ 0.45), else `low`.
- Suggestions come from name/brand overlap against the catalog **and** the scraped
  names of sibling products that already carry each EAN. It's a hint, not a verdict —
  the operator confirms. (We can upgrade the scorer to embeddings/LLM later without
  changing this shape.)
- To bind, send the chosen `ean` (a suggestion's or a hand-picked one) to
  `PATCH /v1/supermarket-products/{mapping.id} { ean }`. The row then disappears from this list.

### Suggested UI (one-click)

A "Missing EAN" queue: each row shows the product name, its chain, a page link, and
the **top suggestion with a confidence badge + a `[✓ Confirm]` button** (plus a
dropdown of the other candidates and a manual EAN field). Default the filter to
`min_confidence=high` so operators clear the obvious matches in seconds, then drop to
`medium`/`low`. **The bulk backlog is cleared from the CLI first (below), so this
screen usually only has a handful of leftovers.**

## `PATCH /v1/supermarket-products/:id` — bind an EAN

Send `{ "ean": "7791234567890" }` (optionally together with `is_active`). The
response echoes the mapping plus an `ean_binding` summary:

```json
{
  "data": {
    "id": "6f1c...",
    "supermarket_id": "coto",
    "product_id": "50bb...",
    "is_active": true,
    "ean_binding": {
      "ean": "7791234567890",
      "productId": "50bb...",
      "merged": true,
      "removedOrphanMaster": true,
      "createdMaster": false
    }
  },
  "meta": { "ts": "..." }
}
```

- `merged: true` — the mapping moved to the canonical master for that EAN.
- `removedOrphanMaster: true` — the old blank master had no other mappings and was deleted.
- `createdMaster` — a canonical master didn't exist yet and was created from the catalog.

### Suggested UI

A "Missing EAN" screen backed by `GET /v1/products/missing-ean`: each row shows
the product name + its chain + a link to the product page. The operator looks up
the product, types/selects the catalog EAN, and the row disappears from the list
once bound. (An EAN picker seeded from the catalog — `GET /v1/catalog/eans` plus
the built-in list — makes this fast.)

---

## `POST /v1/products` — manual add bound to a known EAN (enhanced)

For the chains discovery couldn't cover, the operator pastes a URL from the Cobertura
detail view. To guarantee the ingested product ties to the correct catalog EAN (some
sites don't expose an EAN on the page), pass the known `ean`:

**Request:**
```
POST /v1/products
{ "url": "https://www.cotodigital.com.ar/....", "ean": "7791234567890" }
```

`ean` is optional and only needed when adding from a coverage "missing" cell. Without
it, behavior is unchanged (EAN inferred from the page when possible).

---

## Putting it together — the "new product" workflow

```
[Catalog screen]
  1. Add EAN  ── POST /v1/catalog/eans { ..., auto_discover: true }
                        │
                        ▼
                 returns jobId
  2. Poll     ── GET /v1/data/discover/:jobId   (show a progress bar: done/total, found)
                        │  (auto-ingests matches)
                        ▼
[Cobertura screen]  ── GET /v1/data/coverage?supermarket=<id>&status=missing
  3. For each still-missing chain, paste the product URL
                 POST /v1/products { url, ean }
                        │
                        ▼
              chain flips to "covered"
```

And to stop scraping something:

```
[Supermarket product list]  ── GET /v1/supermarkets/:id/products?status=active
  • Pause  ── PATCH /v1/supermarket-products/:id { is_active: false }
  • Remove ── DELETE /v1/supermarket-products/:id
  • Show paused ── ?status=paused, resume with { is_active: true }
```
