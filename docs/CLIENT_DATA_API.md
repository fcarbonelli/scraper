# Client Data API

How the client pulls the official pricing data (the `client_base` view, the flat
33-column structure their reporting tools expect — including the hardcoded
`SUPLENCIAS` flag and `PESO_PRODUCTO_EN_CATEGORIA` weight, both matched by EAN).

There are two ways to get the exact same data:

| Endpoint | Format | Use case |
|----------|--------|----------|
| `GET /v1/data/pricing` | JSON (paginated) | App / dashboard integrations, incremental sync |
| `GET /v1/data/export` | `.xlsx` or `.csv` file | Manual / scheduled "daily data" downloads |

## Authentication

Every `/v1` request requires an API key in the `X-API-Key` header:

```
X-API-Key: <key>
```

Keys are created with `npm run apikey:create`.

---

## `GET /v1/data/pricing` — JSON

Returns rows from `client_base`, newest first, paginated.

**Query params:**

| Param | Default | Description |
|-------|---------|-------------|
| `page` | `1` | Page number |
| `limit` | `100` | Rows per page (max 1000) |
| `from` | — | Start date (inclusive), `YYYY-MM-DD`, on `Fecha_Relevamiento` |
| `to` | — | End date (inclusive) |
| `supermarket` | — | Comma-separated chains, e.g. `coto,carrefour` |
| `canal` | — | Channel filter, e.g. `SPM NACIONAL` |
| `ean` | — | Single EAN |

**Example:**

```bash
curl -H "X-API-Key: $KEY" \
  "https://<host>/v1/data/pricing?from=2026-06-11&to=2026-06-11&limit=500"
```

**Response:**

```json
{
  "data": [ { "ID": 1, "Fecha_Relevamiento": "2026-06-11", "Cadena": "COTO", "EAN": "...", "Precio_Regular": 1234.5, ... } ],
  "pagination": { "page": 1, "limit": 500, "total": 3900, "totalPages": 8 },
  "meta": { "ts": "2026-06-11T..." }
}
```

To pull a full day programmatically, page through until `page === totalPages`.

---

## `GET /v1/data/export` — Excel / CSV download

Returns the same `client_base` data as a downloadable file. **With no params it
returns just today's data** (Argentina time) — the simplest "daily data" pull.

**Query params:**

| Param | Default | Description |
|-------|---------|-------------|
| `format` | `xlsx` | `xlsx` (real Excel workbook) or `csv` (UTF-8 with BOM) |
| `date` | today | Single day shorthand (sets `from = to = date`) |
| `from` / `to` | — | Explicit date range (overridden by `date`) |
| `supermarket` | — | Comma-separated chains |
| `canal` | — | Channel filter |
| `ean` | — | Single EAN |

The response sets `Content-Disposition: attachment` with a filename like
`client-base_2026-06-11.xlsx`, so browsers download it directly.

**Examples:**

```bash
# Today's data as an Excel file (the daily download)
curl -H "X-API-Key: $KEY" -OJ "https://<host>/v1/data/export"

# A specific day as CSV
curl -H "X-API-Key: $KEY" -OJ \
  "https://<host>/v1/data/export?date=2026-06-10&format=csv"

# A date range, only Coto + Carrefour
curl -H "X-API-Key: $KEY" -OJ \
  "https://<host>/v1/data/export?from=2026-06-01&to=2026-06-11&supermarket=coto,carrefour"
```

Unlike `/pricing`, the export endpoint is **not paginated** — it gathers all
matching rows (internally paging past Supabase's 1000-row cap) and writes them to
a single file. The `.xlsx` is produced with a streaming writer so memory stays
flat as the catalog grows.

---

## Automating the daily download

Any scheduler that can make an authenticated HTTP request works. Examples:

```bash
# cron: every day at 08:30, save today's workbook
30 8 * * *  curl -s -H "X-API-Key: $KEY" -OJ "https://<host>/v1/data/export" \
  --output-dir /data/exports
```

The frontend can also offer a "Download today's data" button that simply links to
`/v1/data/export` with the API key attached (e.g. via a short-lived proxy or a
server-side download route, so the key isn't exposed in the browser).

---

## Notes & future fields

`PRECIO_TGT_SPM` and `PRECIO_TGT_MAY` are populated from the client's **Price
List** (`price_targets`, loaded via `npm run lp:import <file.xlsx>` — migration
012). Each row shows only the target for its own channel: supermarket rows
(`Canal` `SPM ...`) carry `PRECIO_TGT_SPM`, mayorista rows (`MAY ...`) carry
`PRECIO_TGT_MAY`; the other stays empty, as does any EAN not in the list.

`SUPLENCIAS` is hardcoded client reference data (from the "Productos (EAN)"
Setup sheet), stamped onto each row by EAN: `TITULAR` (primary/reference item),
`SUPLENTE` (stand-in), or empty for EANs the client didn't tag. It sits right
after `Variedad` in both the JSON (`Suplencias`) and the file export
(`SUPLENCIAS` column) and is not a real column of the `client_base` view — see
`src/shared/suplencias.ts`.

`PESO_PRODUCTO_EN_CATEGORIA` is hardcoded client reference data (from the weekly
pricing workbook), stamped onto each row by EAN: the product's share/weight in
its category as a ratio (0..1), or empty for EANs the client didn't tag. It sits
right after `PRECIO_PRODUCTO_EN_CATEGORIA` in both outputs and is not a real
column of the `client_base` view — see `src/shared/pesoEnCategoria.ts`.

Two columns remain intentionally empty until their logic is defined:
`IDX_VS_COMPETENCIA` and `PRECIO_PRODUCTO_EN_CATEGORIA`. All columns appear in
both the JSON and the file export so the structure is stable.
