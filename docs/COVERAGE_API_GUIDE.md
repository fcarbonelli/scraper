# Product Coverage API -- Frontend Integration Guide

## Overview

The coverage endpoint tells you **which of the 211 client EANs each supermarket has vs is missing**. It cross-references the client's product taxonomy (hardcoded in the backend) against the actual `supermarket_products` mappings in the database.

No data needs to be "marked" as missing -- the backend computes it in real time. When a product is added (via URL ingest or automated discovery), it automatically moves from "missing" to "covered".

---

## Authentication

Same as all `/v1` endpoints: pass the API key in the `X-API-Key` header.

---

## Endpoints

### `GET /v1/data/coverage` -- Summary (all supermarkets)

Returns a high-level count per supermarket: how many of the 211 EANs are covered vs missing.

**Request:**
```
GET /v1/data/coverage
X-API-Key: <key>
```

**Response:**
```json
{
  "data": {
    "totalEans": 211,
    "supermarkets": [
      {
        "id": "carrefour",
        "name": "Carrefour Argentina",
        "canal": "SPM NACIONAL",
        "cadenaDisplayName": "CARREFOUR",
        "isActive": true,
        "hasAdapter": true,
        "hasSearch": true,
        "covered": 164,
        "missing": 47,
        "coveragePct": 77.7
      },
      {
        "id": "coto",
        "name": "Coto Digital",
        "canal": "SPM NACIONAL",
        "cadenaDisplayName": "COTO",
        "isActive": true,
        "hasAdapter": true,
        "hasSearch": false,
        "covered": 22,
        "missing": 189,
        "coveragePct": 10.4
      },
      {
        "id": "makro",
        "name": "Makro",
        "canal": "MAY NACIONAL",
        "cadenaDisplayName": "MAKRO",
        "isActive": false,
        "hasAdapter": false,
        "hasSearch": false,
        "covered": 0,
        "missing": 211,
        "coveragePct": 0
      }
    ]
  },
  "meta": { "ts": "2026-06-04T..." }
}
```

**Field descriptions:**

| Field | Description |
|-------|-------------|
| `totalEans` | Total products in the client's catalog (currently 211) |
| `id` | Supermarket ID (used for detail queries and API calls) |
| `name` | Human-readable supermarket name |
| `canal` | Channel: `SPM NACIONAL`, `SPM REGIONAL`, `MAY NACIONAL`, `MAY REGIONAL` |
| `cadenaDisplayName` | Uppercase chain name for reports |
| `isActive` | Whether the supermarket is enabled for daily scraping |
| `hasAdapter` | Whether a scraping adapter exists for this chain |
| `hasSearch` | Whether automated EAN discovery is supported (for "Run Discovery" button) |
| `covered` | Number of catalog EANs that have a mapping at this supermarket (active OR paused) |
| `missing` | Number of catalog EANs NOT mapped at this supermarket |
| `paused` | Of the covered EANs, how many have **only** paused mappings (not being scraped) |
| `coveragePct` | Coverage percentage (0-100, one decimal) |

> **Paused vs missing:** a *paused* mapping (`is_active=false`, set via
> `PATCH /v1/supermarket-products/:id`) still counts as **covered** — we have the URL,
> we've just stopped scraping it. It is never silently reported as `missing`.

---

### `GET /v1/data/coverage?supermarket=<id>` -- Detail (single supermarket)

Returns the full EAN-level breakdown for one supermarket: every product in the catalog with its status (`covered` or `missing`).

**Request:**
```
GET /v1/data/coverage?supermarket=carrefour
X-API-Key: <key>
```

**Optional filters:**
- `?status=missing` -- only show missing products
- `?status=covered` -- only show covered products
- `?category=LAVANDINAS` -- filter by product category

**Response:**
```json
{
  "data": {
    "supermarket": {
      "id": "carrefour",
      "name": "Carrefour Argentina",
      "canal": "SPM NACIONAL",
      "cadenaDisplayName": "CARREFOUR",
      "isActive": true,
      "hasAdapter": true,
      "hasSearch": true
    },
    "totalEans": 211,
    "covered": 164,
    "missing": 47,
    "coveragePct": 77.7,
    "products": [
      {
        "ean": "7793253005054",
        "descriptionForms": "AERO DESINF AYUDIN 332 OR",
        "category": "AERO",
        "subcategory": "DESINF",
        "brand": "AYUDIN",
        "status": "covered",
        "url": "https://www.carrefour.com.ar/desinfectante-ayudin-expert-original-aerosol-332-cc/p"
      },
      {
        "ean": "7798125150139",
        "descriptionForms": "DESTAPACANERIAS MERCLIN 500ML",
        "category": "DESTAPACANERIAS",
        "subcategory": "DESTAPACANERIAS",
        "brand": "MERCLIN",
        "status": "missing",
        "url": null
      }
    ]
  },
  "meta": { "ts": "2026-06-04T..." }
}
```

**Product fields:**

| Field | Description |
|-------|-------------|
| `ean` | Product barcode (EAN-13) |
| `descriptionForms` | Client's official product description |
| `category` | Product category (e.g. `LAVANDINAS`, `AERO`, `INSECTICIDAS`) |
| `subcategory` | Subcategory (e.g. `GEL`, `REG`, `DESINF`) |
| `brand` | Brand name (e.g. `AYUDIN`, `CIF`) |
| `status` | `"covered"` (product exists at this supermarket) or `"missing"` |
| `active` | `true` if scraped, `false` if the mapping is paused, `null` if missing |
| `url` | Product page URL if covered, `null` if missing |

---

### `GET /v1/data/coverage?supermarket=carrefour,coto`

When passing multiple comma-separated IDs, returns the **summary** format (not detail) filtered to just those supermarkets.

---

## Suggested Frontend UI

### 1. Coverage Dashboard (summary view)

A table where each row is a supermarket:

| Cadena | Canal | Covered | Missing | Coverage | Adapter | Actions |
|--------|-------|---------|---------|----------|---------|---------|
| CARREFOUR | SPM NACIONAL | 164 | 47 | ████████░░ 77.7% | Scraper + Search | [View Details] |
| COTO | SPM NACIONAL | 22 | 189 | ██░░░░░░░░ 10.4% | Scraper only | [View Details] |
| MAKRO | MAY NACIONAL | 0 | 211 | ░░░░░░░░░░ 0% | None | -- |

**Implementation notes:**
- Sort by `coveragePct` descending (most complete first) or by `canal` for grouping
- Use `isActive` to visually distinguish active vs inactive chains (e.g. gray out inactive)
- Use `hasAdapter` and `hasSearch` to determine the "Adapter" column badge:
  - `hasSearch: true` -> "Scraper + Search" (can run automated discovery)
  - `hasAdapter: true, hasSearch: false` -> "Scraper only"
  - `hasAdapter: false` -> "None" (no adapter built yet)
- The progress bar maps `coveragePct` to a visual bar (0-100%)

**Filtering:**
- Filter by `canal` (dropdown: all channels, or one specific)
- Toggle: show only active supermarkets vs all
- Sort: by coverage %, by name, by channel

### 2. Detail View (per-supermarket EAN list)

Shown when clicking "View Details" on a supermarket row. Fetch: `GET /v1/data/coverage?supermarket=<id>`

A table of all 211 products:

| EAN | Product | Category | Brand | Status | URL |
|-----|---------|----------|-------|--------|-----|
| 7793253005054 | AERO DESINF AYUDIN 332 OR | AERO | AYUDIN | ✅ Covered | [Link] |
| 7798125150139 | DESTAPACANERIAS MERCLIN 500ML | DESTAPACANERIAS | MERCLIN | ❌ Missing | -- |

**Implementation notes:**
- Default filter: show "missing" first (these are the actionable items)
- Filter by `status` (covered/missing/all) -- use `?status=missing` query param
- Filter by `category` -- use `?category=LAVANDINAS` query param
- Searchable by product description or EAN
- When `status=missing`, this is the "shopping list" for manual URL hunting
- Show the total counts at the top: "164 covered, 47 missing (77.7%)"

### 3. Export Missing List

Add an "Export" button on the detail view (when filtered to `status=missing`) that downloads a CSV:

```csv
EAN,Product,Category,Brand
7798125150139,DESTAPACANERIAS MERCLIN 500ML,DESTAPACANERIAS,MERCLIN
...
```

This can be built entirely on the frontend by converting the `products` array to CSV.

---

## Product Categories

The 211 products span these categories (useful for filter dropdowns):

- `AERO` -- aerosol products (disinfectants, fragrances)
- `CANASTAS` -- toilet basket fresheners
- `DESTAPACANERIAS` -- drain cleaners
- `ESPECIFICOS` -- targeted cleaners (bathroom, kitchen, multi-surface, anti-mold)
- `INSECTICIDAS` -- insecticides (mosquito, cockroach, home & garden)
- `INTENSE` -- intense fragrance refills
- `LAD` -- laundry additives (whiteners, stain removers, powders)
- `LAVANDINAS` -- bleach (regular, gel, fragranced, concentrated)
- `LIQUIDOS` -- floor cleaners (light and heavy duty)
- `NAT BLENDS` -- natural blend fragrances
- `PERF P/ TELA` -- fabric perfumes
- `REPELENTES` -- insect repellents
- `TOALLITAS` -- cleaning wipes
- `UTEN DE LIMP` -- cleaning utensils (sponges, gloves, bags, pads)

---

## Automated Discovery Trigger (implemented)

For supermarkets where `hasSearch: true`, the frontend can trigger automated EAN
discovery via **`POST /v1/data/discover`** (async job; poll `GET /v1/data/discover/:jobId`).
Full request/response shapes and the end-to-end "add a new EAN" workflow are documented
in **`docs/PRODUCT_MANAGEMENT_API.md`**.

The coverage view can show a "Run Discovery" button for eligible supermarkets
(`{ supermarket: "<id>" }`) or discover a single new EAN across every searchable chain
(`{ ean: "<ean>" }`). Results are reflected in the next coverage query automatically.
