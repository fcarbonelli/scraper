# Product Management API — Frontend Integration Guide

> Status: **LIVE** (pending deploy + migration 007). Backend design:
> `docs/PRODUCT_MANAGEMENT.md`. Shapes below follow the standard envelope
> (`{ data, meta }` on success, `{ error }` on failure) used by every `/v1` route.

## Authentication

Same as every `/v1` endpoint: pass the API key in the `X-API-Key` header.

## What you can build with this

1. **Pause / remove** a product at a specific supermarket (from the per-supermarket
   product list).
2. **Add a new EAN** to the catalog and **auto-discover** it across all searchable
   supermarkets, then fill the gaps from the **Cobertura** (coverage) screen.

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
