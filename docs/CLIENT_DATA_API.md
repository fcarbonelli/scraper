# Client Data API

How the client pulls the official pricing data (the `client_base` view, the flat
structure their reporting tools expect — including the hardcoded `SUPLENCIAS`
flag, `PESO_PRODUCTO_EN_CATEGORIA` weight, `NUEVA_CATEGORIZACION` code and
`IX_TARGET_VS_COMPETENCIA` index, all matched by EAN, plus the derived
`DIFF_VS_EDP` / `IDX_VS_COMPETENCIA` indicators).

The `/pricing` JSON returns **38 fields per record**; the `/export` file has
**36 columns** (it omits the two legacy placeholders `Index_Competencia` /
`Marca_Competencia`, which the JSON keeps but always leaves empty). The
canonical, field-by-field reference the client integrates against is
**`docs/API_PRICING_CLIENTE.md`** — keep that doc and `src/api/lib/clientPricing.ts`
(the `toPriceData` mapper) as the source of truth for exact field names and shapes.

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

**Response:** the client contract envelope (NOT the generic `{ data, pagination,
meta }` shape). Every value inside `PriceData` is delivered as a **string**, and
field names are the client-facing renames (e.g. `ID` → `Pricing_Id`,
`Precio_MasBajo` → `Precio_Mas_Bajo`):

```json
{
  "ProcesadoOk": true,
  "Error": "",
  "PriceData": [
    {
      "Pricing_Id": "145090",
      "Fecha_Relevamiento": "2026-07-30",
      "Cadena": "MAKRO",
      "Canal": "MAY NACIONAL",
      "EAN": "7790132098459",
      "Precio_Regular": "1820",
      "PRECIO_TGT_MAY": "1273",
      "DIFF_VS_EDP": "43%",
      "IDX_VS_COMPETENCIA": "",
      "IX_TARGET_VS_COMPETENCIA": "120",
      "PESO_PRODUCTO_EN_CATEGORIA": "0.36",
      "NUEVA_CATEGORIZACION": "LAVANDINAS_REG_1L_A"
    }
  ],
  "Paginacion": { "Pagina": 1, "Limite": 500, "TotalRegistros": 72689, "TotalPaginas": 146 }
}
```

The record above is abridged — each record always carries the full 38-field set
(see `docs/API_PRICING_CLIENTE.md` §5 for every field). To pull a full day
programmatically, page through until `Paginacion.Pagina === Paginacion.TotalPaginas`.

> **"A field looks missing":** the key is always present; it may just be an empty
> string (`""`) because it does not apply to that row. In particular:
> `IDX_VS_COMPETENCIA` is filled only on competitor rows (`NUEVA_CATEGORIZACION`
> ending in `A1`); `PRECIO_TGT_SPM` only on `SPM ...` channel rows and
> `PRECIO_TGT_MAY` only on `MAY ...` rows; `Precio_c_Oferta_2` / `Promocion_2`
> only when a 2nd promo exists; the hardcoded reference fields (`Suplencias`,
> `PESO_PRODUCTO_EN_CATEGORIA`, `IX_TARGET_VS_COMPETENCIA`, `NUEVA_CATEGORIZACION`)
> are empty for EANs the client never classified; and `Index_Competencia` /
> `Marca_Competencia` are legacy and intentionally always empty.

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
| `preview` | `false` | **Operator-only.** `true`/`1` includes not-yet-approved (`pending_review`) days so you can check today's data before publishing. Adds a `_preview` filename suffix. The client JSON feed (`/pricing`) ignores this. |

The response sets `Content-Disposition: attachment` with a filename like
`client-base_2026-06-11.xlsx` (or `client-base_2026-06-11_preview.xlsx` for a
preview download), so browsers download it directly.

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
its category as a ratio (0..1), or empty for EANs the client didn't tag. It is
not a real column of the `client_base` view — see
`src/shared/pesoEnCategoria.ts`.

`NUEVA_CATEGORIZACION` is likewise hardcoded client reference data (from the
"Estructura Base" workbook): an analytical re-categorization code per product
(e.g. `LAVANDINAS_REG_1L_A1`), or empty for untagged EANs. Stamped by EAN, not a
real column of the view — see `src/shared/nuevaCategorizacion.ts`.

`DIFF_VS_EDP` and `IDX_VS_COMPETENCIA` are **derived indicators**, computed at the
app layer (they depend on the hardcoded maps above, not on view columns) and
formatted as a whole-number percentage string (`"23%"`, `"-5%"`, or empty) — see
`src/shared/priceIndicators.ts`:

- `DIFF_VS_EDP` — `Precio_Regular` vs. the EDP target: `round(Precio_Regular /
  (PRECIO_TGT_SPM | PRECIO_TGT_MAY) − 1)`. Only one target is present per row
  (channel-dependent); empty when there's no price or no target.
- `IDX_VS_COMPETENCIA` — a competitor's price vs. the Ayudín equivalent's:
  `round(competitorPR / ayudinPR − 1)`. `NUEVA_CATEGORIZACION` codes end in `A`
  (Ayudín) or `A1` (competitor); each competitor (`…A1`) row is divided by the
  Ayudín (`…A`) row's `Precio_Regular` in the **same supermarket on the same
  date** (first match when several share the code). Only competitor rows get a
  value; Ayudín rows stay empty.

`IX_TARGET_VS_COMPETENCIA` is hardcoded client reference data (from the
"Estructura Base" workbook, sheet "IX Target"): a target-vs-competitor index per
product, or empty for untagged EANs. Stamped by EAN, not a real column of the
view — see `src/shared/ixTargetVsCompetencia.ts`.

All columns appear in both the JSON and the file export so the structure is
stable. (The former `PRECIO_PRODUCTO_EN_CATEGORIA` column was dropped from both
outputs; the underlying view column is left in place but no longer emitted.)
