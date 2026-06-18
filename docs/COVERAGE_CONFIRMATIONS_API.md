# Coverage Confirmations API — Frontend Integration Guide

## Why this exists

The coverage endpoint (`GET /v1/data/coverage`) computes "covered vs missing" by matching each of the catalog EANs against the products we've scraped at each chain.

The problem: **some supermarkets don't expose an EAN on their product pages.** For those chains we can't auto-match the scraped product to a catalog EAN, so the product shows as **`missing`** even though we actually have it. That makes the "what do we still need to find" list unreliable for those chains.

**Coverage confirmations** fix this. An operator can manually mark a catalog EAN as "we have this" for a given chain. The mark is:

- **Shared** across all users (stored server-side, not in localStorage).
- **Auditable** (records who confirmed it and when).
- **Idempotent** (two operators confirming the same product is safe).

A confirmation is purely a coverage annotation. It does **not** create price data — it only tells the UI "yes, this chain carries this product, stop showing it as missing."

---

## Authentication

Same as every `/v1` endpoint: pass the API key in the `X-API-Key` header.

---

## The easy path: read `confirmed` straight off coverage

`GET /v1/data/coverage?supermarket=<id>` now includes confirmation fields on every product in **detail mode**. You do **not** need a separate fetch to reconcile.

**Request:**
```
GET /v1/data/coverage?supermarket=coto
X-API-Key: <key>
```

**Response (per-product fields, new ones marked NEW):**
```json
{
  "data": {
    "supermarket": {
      "id": "coto",
      "name": "Coto Digital",
      "canal": "SPM NACIONAL",
      "cadenaDisplayName": "COTO",
      "isActive": true,
      "hasAdapter": true,
      "hasSearch": false
    },
    "totalEans": 211,
    "covered": 22,
    "missing": 189,
    "confirmed": 7,
    "coveragePct": 10.4,
    "products": [
      {
        "ean": "7791234500012",
        "descriptionForms": "LAVANDINA AYUDIN 1L",
        "category": "LAVANDINAS",
        "subcategory": "REG",
        "brand": "AYUDIN",
        "status": "missing",
        "url": null,
        "confirmed": true,
        "confirmedBy": "ops-fran",
        "confirmedAt": "2026-06-18T14:00:00Z"
      },
      {
        "ean": "7798125150139",
        "descriptionForms": "DESTAPACANERIAS MERCLIN 500ML",
        "category": "DESTAPACANERIAS",
        "subcategory": "DESTAPACANERIAS",
        "brand": "MERCLIN",
        "status": "missing",
        "url": null,
        "confirmed": false,
        "confirmedBy": null,
        "confirmedAt": null
      }
    ]
  },
  "meta": { "ts": "2026-06-18T..." }
}
```

**New fields:**

| Field | Type | Description |
|-------|------|-------------|
| `confirmed` | boolean | `true` if an operator manually marked this EAN as covered for this chain. |
| `confirmedBy` | string \| null | Who confirmed it (operator label or API key name). `null` when `confirmed` is `false`. |
| `confirmedAt` | string \| null | ISO timestamp of the confirmation. `null` when `confirmed` is `false`. |
| `confirmed` (top-level, on `data`) | number | Count of confirmed EANs for this chain. |

### Computing "real missing"

Do this client-side off the detail response — it's consistent for everyone because the flag is server-side:

```ts
const reallyMissing = products.filter(
  (p) => p.status === "missing" && !p.confirmed
);
```

`status` is left untouched on purpose (it still reflects the raw EAN-match result). `confirmed` is the operator override layered on top.

> Summary mode (`GET /v1/data/coverage` with no/multiple `supermarket`) also gains a per-chain `confirmed` count so the dashboard can show "real missing" totals without fetching every detail.

---

## Managing confirmations

### Confirm a product — "We have it"

```
POST /v1/data/coverage/confirmations
X-API-Key: <key>
Content-Type: application/json
```

**Body:**
```json
{
  "supermarketId": "coto",
  "ean": "7791234500012",
  "note": "match manual, sin EAN en la ficha",
  "confirmedBy": "ops-fran"
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `supermarketId` | yes | Must be a known supermarket id. |
| `ean` | yes | Must be one of the catalog EANs. |
| `note` | no | Free text, e.g. why it was confirmed manually. |
| `confirmedBy` | no | Operator label. Falls back to the API key name if omitted. |

**Responses:**
```jsonc
// 201 Created — first time this EAN is confirmed for this chain
{
  "data": {
    "id": "…uuid…",
    "supermarketId": "coto",
    "ean": "7791234500012",
    "note": "match manual, sin EAN en la ficha",
    "confirmedBy": "ops-fran",
    "confirmedAt": "2026-06-18T14:00:00Z"
  },
  "meta": { "ts": "…" }
}

// 200 OK — already confirmed (idempotent; returns the original row, unchanged)
{ "data": { …same shape… }, "meta": { "ts": "…" } }
```

**Errors:**

| Status | Code | When |
|--------|------|------|
| 400 | `INVALID_REQUEST` | Missing `ean`, or unknown `supermarketId`, or `ean` not in the catalog. |
| 401 | `UNAUTHORIZED` | Missing/invalid API key. |

Idempotency: confirming an already-confirmed EAN returns `200` with the **original** row (the first `confirmedBy`/`confirmedAt` is preserved, not overwritten). Safe to call from two operators.

### Un-confirm a product — "Undo"

Deleted by composite key via query params (the same `supermarketId` + `ean` you already have in the coverage list — no id lookup needed).

```
DELETE /v1/data/coverage/confirmations?supermarket=coto&ean=7791234500012
X-API-Key: <key>
```

**Response (idempotent — `200` even if nothing was there):**
```json
{ "data": { "deleted": true }, "meta": { "ts": "…" } }
```

### List confirmations (audit panel — optional)

You normally don't need this because the flag is folded into `/data/coverage`. Use it only for an audit/history view.

```
GET /v1/data/coverage/confirmations?supermarket=coto
X-API-Key: <key>
```

**Response:**
```json
{
  "data": [
    {
      "id": "…uuid…",
      "supermarketId": "coto",
      "ean": "7791234500012",
      "note": "match manual, sin EAN en la ficha",
      "confirmedBy": "ops-fran",
      "confirmedAt": "2026-06-18T14:00:00Z"
    }
  ],
  "meta": { "ts": "…" }
}
```

---

## Suggested frontend wiring

In the per-supermarket detail view (the EAN list), each `missing` row gets a **"Confirmar"** button; confirmed rows show a **"Deshacer"** button plus who/when.

- **Confirmar** → `POST /v1/data/coverage/confirmations`, then invalidate the `["coverage"]` query.
- **Deshacer** → `DELETE /v1/data/coverage/confirmations?supermarket=…&ean=…`, then invalidate `["coverage"]`.
- Read `confirmed` / `confirmedBy` / `confirmedAt` directly from the coverage detail response — no separate fetch, no client-side merge, no localStorage.
- Default the "missing" filter to **real missing** (`status === "missing" && !confirmed`) so confirmed-but-EAN-less products drop off the to-do list.

Suggested React Query shape:

```ts
queryKeys.coverage.confirmations(supermarketId) // for the optional audit list
// mutations: confirmCoverage(), unconfirmCoverage() — both invalidate ["coverage"]
```

---

## Notes / guarantees

- Confirmations **augment** coverage; they never block or change `status`. `/data/coverage` works the same whether or not confirmations exist.
- `confirmed: true` means "an operator asserts this chain carries this product." It does **not** mean we have a tracked price for it — it's a coverage/visibility flag only.
- One confirmation per `(supermarketId, ean)` pair (DB unique constraint). That pair is the idempotency key for both POST and DELETE.
