# Catalog (scraped/exported products) API — Frontend Integration Guide

## Why this exists

The old **Catálogo** screen was backed by `GET /v1/products`, which lists **every**
row in the master `products` table — including EAN‑less junk, products that were
ingested once and never scraped again, and products whose every mapping is
paused. That's why it shows deactivated / stale items and the count never matches
what the client actually receives.

`GET /v1/data/catalog` replaces it with the **exportable set**: the distinct
master products that have **at least one ACTIVE mapping on an ACTIVE chain** —
i.e. exactly what the daily `client_base` export emits. The definition mirrors
the export's active gate (`supermarkets.is_active = true AND
supermarket_products.is_active = true`), so `summary.totalProducts` is the number
the client view should match (~238).

> This is a **product‑centric** view ("what do we scrape, and where"). It
> complements the **EAN/catalog‑centric** coverage view
> (`GET /v1/data/coverage`, see `docs/COVERAGE_API_GUIDE.md`) which answers
> "which of the reference EANs is each chain missing".

---

## Authentication

Same as all `/v1` endpoints: pass the API key in the `X-API-Key` header.

---

## `GET /v1/data/catalog`

Paginated list of exportable products **plus** a `summary` KPI block in `meta`.
The `summary` always describes the **whole unfiltered universe**, so the headline
numbers stay stable regardless of the active filters or page. The `pagination`
block reflects the **filtered** result set.

### Query params

| Param | Default | Description |
|-------|---------|-------------|
| `page` | `1` | Page number |
| `limit` | `50` | Rows per page (1..500). Pass `limit=500` to fetch everything in one call. |
| `search` | — | Case‑insensitive contains match against name **/** EAN **/** description |
| `category` | — | Exact category (case‑insensitive) |
| `brand` | — | Exact brand (case‑insensitive) |
| `supermarket` | — | Comma‑separated chain ids (e.g. `coto,carrefour`) — keep products present at any of them |
| `status` | `all` | `active` \| `paused` \| `all`. Combined with `supermarket`, restricts to products whose mapping **at those chains** is active/paused. With **no** `supermarket`, `paused` surfaces products that have any paused mapping. |
| `sort` | `name` | `name` \| `coverage_desc` \| `coverage_asc` \| `category` |

### Example

```bash
curl -H "X-API-Key: $KEY" \
  "https://<host>/v1/data/catalog?supermarket=coto&sort=coverage_desc&limit=100"
```

### Response

```json
{
  "data": [
    {
      "productId": "50bb31b8-...",
      "ean": "7793253006709",
      "name": "Lavandina Original Ayudin 2L",
      "descriptionForms": "LAVANDINA AYUDIN ORIGINAL 2L",
      "category": "Lavandinas Liquidas",
      "subcategory": "REGULAR",
      "brand": "AYUDIN",
      "manufacturer": "GRUPO AYUDIN",
      "format": "2L",
      "variety": "ORIGINAL",
      "unit": "2 Litro",
      "imageUrl": "https://.../00591050.jpg",
      "chainsActive": 6,
      "chainsPaused": 1,
      "chainsTotal": 7,
      "chains": [
        { "id": "coto", "name": "Coto Digital", "cadenaDisplayName": "COTO", "canal": "SPM NACIONAL", "status": "active", "url": "https://..." },
        { "id": "jumbo", "name": "Jumbo", "cadenaDisplayName": "JUMBO", "canal": "SPM NACIONAL", "status": "paused", "url": "https://..." }
      ],
      "inLatestExport": true,
      "latestExportChains": 6,
      "priceMin": 2450.0,
      "priceMax": 3120.5
    }
  ],
  "pagination": { "page": 1, "limit": 50, "total": 238, "totalPages": 5 },
  "meta": {
    "ts": "2026-07-24T...",
    "summary": {
      "totalProducts": 238,
      "totalActiveMappings": 1204,
      "totalPausedMappings": 63,
      "activeChains": 14,
      "totalChains": 31,
      "catalogEans": 217,
      "lastExportDate": "2026-07-24",
      "rowsInLastExport": 1187,
      "productsInLastExport": 231,
      "bySupermarket": [
        { "id": "carrefour", "name": "Carrefour Argentina", "canal": "SPM NACIONAL", "cadenaDisplayName": "CARREFOUR", "isActive": true, "active": 198, "paused": 6, "total": 204 }
      ]
    }
  }
}
```

### Product fields

| Field | Description |
|-------|-------------|
| `productId` | Master product UUID (use with `/v1/products/:id`, `/compare`, `/history`) |
| `ean` | Barcode (may be `null` for EAN‑less products — a data‑quality signal) |
| `name` | Master product name |
| `descriptionForms` | Client's official description (`Descripcion_para_Forms`) |
| `category` / `subcategory` / `brand` / `manufacturer` / `format` / `variety` | Client taxonomy |
| `unit` | Free‑text unit ("2 Litro", "1 Kg", …) |
| `imageUrl` | Product image (from `metadata.imageUrl`), or `null` |
| `chainsActive` | Active mappings on active chains (what gets scraped) |
| `chainsPaused` | Paused mappings on active chains (kept, not scraped) |
| `chainsTotal` | `chainsActive + chainsPaused` |
| `chains[]` | Per‑chain breakdown (active chains only), sorted by name — for the drilldown |
| `chains[].status` | `active` (scraped daily) or `paused` (mapping `is_active=false`) |
| `inLatestExport` | Whether this product's EAN appears in the most recent daily export |
| `latestExportChains` | How many chains emitted a row for it in the latest export |
| `priceMin` / `priceMax` | Lowest / highest `Precio_MasBajo` across chains in the latest export (`null` if none) |

### Summary (KPI) fields — `meta.summary`

| Field | Description |
|-------|-------------|
| `totalProducts` | **Distinct exportable products** — the headline count (~238) |
| `totalActiveMappings` | Active mappings on active chains across the exportable set |
| `totalPausedMappings` | Paused mappings on active chains across the exportable set |
| `activeChains` / `totalChains` | Active supermarkets / all supermarkets |
| `catalogEans` | Size of the reference EAN catalog (hardcoded ∪ runtime extras) |
| `lastExportDate` | Most recent `Fecha_Relevamiento` in `client_base` (`null` if empty) |
| `rowsInLastExport` | `client_base` rows on `lastExportDate` |
| `productsInLastExport` | Distinct products (by EAN) in the latest export |
| `bySupermarket[]` | Per‑chain rollup of the exportable set: `{ id, name, canal, cadenaDisplayName, isActive, active, paused, total }` |

> **`inLatestExport: false` on an exportable product** means it's configured to be
> scraped but didn't produce a row on the last export day (e.g. a failed scrape,
> or an unpublished run). It's the actionable "should be there but isn't" list.

---

## Suggested Frontend UI

### 1. KPI header

Render `meta.summary` as stat cards: **Productos exportados** (`totalProducts`),
**Mapeos activos** (`totalActiveMappings`), **Pausados** (`totalPausedMappings`),
**Cadenas activas** (`activeChains`/`totalChains`), **Último export**
(`lastExportDate` + `productsInLastExport` de `totalProducts`). These come free on
every page response.

### 2. Products table

| Producto | EAN | Categoría | Marca | Cadenas (act/pausa) | En último export | Precio (min–max) |
|----------|-----|-----------|-------|---------------------|------------------|------------------|

- Search box → `?search=`; category/brand dropdowns → `?category=`/`?brand=`
  (build option lists from the distinct values you receive, or from the coverage
  guide's category list).
- Sort control → `?sort=` (`coverage_desc` is a good "most‑covered first" default).
- Row expander shows `chains[]` as status chips (green = active, gray = paused)
  linking to `chains[].url`.
- Flag rows where `inLatestExport === false` (amber) — the "expected but missing
  today" worklist.
- Flag rows where `ean === null` (needs EAN binding — link to the heal flow,
  `PATCH /v1/supermarket-products/:id { ean }`).

### 3. Per‑supermarket coverage panel + filter

Use `meta.summary.bySupermarket` for a compact "coverage per chain" table
(active/paused/total of the exportable set). Clicking a chain sets
`?supermarket=<id>` to filter the products table to just what that chain carries,
and the `?status=active|paused` toggle drills into paused vs scraped there.

> For the **catalog‑gap** angle ("which reference EANs is this chain missing"),
> deep‑link to the coverage view (`GET /v1/data/coverage?supermarket=<id>`).

### Pausing / resuming

Each `chains[]` entry maps to a `supermarket_products` row. To pause/resume a
product at a chain, resolve the mapping id (via `GET
/v1/supermarkets/:id/products?status=all` or `/v1/products/:id/compare`) and
`PATCH /v1/supermarket-products/:id { "is_active": false|true }`. A follow‑up
`GET /v1/data/catalog` reflects the change (mappings aggregate live).

---

## Relationship to other endpoints

| Need | Endpoint |
|------|----------|
| The exportable catalog + KPIs (this guide) | `GET /v1/data/catalog` |
| Reference‑EAN coverage per chain (covered/missing) | `GET /v1/data/coverage` |
| One product's live price across chains | `GET /v1/products/:id/compare` |
| One product's price history | `GET /v1/products/:id/history` |
| The raw client export (rows the client downloads) | `GET /v1/data/pricing`, `GET /v1/data/export` |
| Pause/resume/heal a single mapping | `PATCH /v1/supermarket-products/:id` |
