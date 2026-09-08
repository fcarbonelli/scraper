# Promotions Dashboard — Build Guide

Everything a frontend needs to build a **bank/card promotions dashboard** on top
of the promos module (Naranja X + MODO, ~26k+ promotions across 82 banks). This
surface is fully isolated from the supermarket-pricing client.

- **Design/back-end details:** [`BANK_PROMOS.md`](./BANK_PROMOS.md)
- **Adding more banks:** [`BANK_PROMOS_ROADMAP.md`](./BANK_PROMOS_ROADMAP.md)

---

## 1. Auth & base URL

- **Base:** same host as the main API, prefix **`/v1/promos`**.
- **Header:** `X-API-Key: <promos-dashboard key>` (the `promos`-scoped key).
  - A `promos` key is rejected (`403`) on every non-promos route, and the
    supermarket client key is rejected (`403`) here. The data never crosses over.
- **Envelope:** lists → `{ data, pagination, meta }`; single/collection →
  `{ data, meta }`. Errors → `{ error: { code, message, details? }, meta }`.

```bash
KEY=<promos-dashboard key>
BASE=https://<your-api-host>
curl -s -H "X-API-Key: $KEY" "$BASE/v1/promos/filters"
```

---

## 2. Endpoints (all GET)

| Endpoint | Use in the UI |
| --- | --- |
| `GET /v1/promos/filters` | Populate the filter controls (providers, **issuers/banks**, categories, payment methods, weekdays, purchase modes). Call once on load. |
| `GET /v1/promos` | The main grid: paginated + filterable list of promo cards. |
| `GET /v1/promos/:id` | Card detail drawer/page (adds `plans` + `raw`). |
| `GET /v1/promos/providers` | Optional header/stat: providers + `activePromotions` counts + `lastRunAt`. |

### `GET /v1/promos` query params (all optional, AND-combined)

| Param | Type | Notes |
| --- | --- | --- |
| `provider` | string | `naranjax` \| `modo` |
| `issuer` | string | **Bank name, substring** (`Galicia`, `Macro`, `MODO`…). The key bank filter. |
| `category` | string | Taxonomy key, e.g. `SUPERMERCADOS` (from `/filters`). |
| `paymentMethod` | string | `CREDITO`,`DEBITO`,`VISA`,`MASTER`,`AMEX`,… |
| `weekday` | string | `MONDAY`…`SUNDAY` or `ALL_DAYS`. |
| `purchaseMode` | string | `ONLINE` \| `IN_STORE`. |
| `merchant` | string | Substring search (mostly Naranja X). |
| `minDiscount` | int | Minimum `max_discount_pct` (e.g. `20`). |
| `featured` | bool | `true` \| `false`. |
| `activeOnly` | bool | Default `true` (currently-running promos). |
| `page`, `limit` | int | Pagination (`limit` default 20). |

Sort order is fixed server-side: featured first, then highest discount, then
merchant.

---

## 3. Promo card fields (list response `data[]`)

The fields you'll render on a card:

| Field | Meaning |
| --- | --- |
| `id` | Promotion id (use for `/v1/promos/:id`). |
| `provider_id` | `naranjax` \| `modo` (source badge). |
| `issuer` | **Issuing bank** ("Galicia", "Credicoop", "MODO" = cross-bank, "Naranja X"). Primary grouping. |
| `title` | Headline, e.g. "30% en Tienda Macro Nivel 3". |
| `merchant` | Commerce name when known (null for network-wide promos). |
| `category` / `category_name` | Taxonomy key / human label. |
| `subtitle` | Where/how ("Comercios adheridos"). |
| `payment_methods` | Chips: `["CREDITO","VISA",…]`. |
| `weekdays` | Chips: `["WEDNESDAY"]` / `["ALL_DAYS"]`. |
| `purchase_modes` | `["ONLINE","IN_STORE"]`. |
| `max_discount_pct` | Big number badge (may be null). |
| `max_installments` | "Nx cuotas" badge (may be null). |
| `valid_from` / `valid_to` | Validity window (ISO). |
| `image_url` / `logo_url` | Card art / brand logo (may be null). |
| `is_featured` | Highlight/carousel flag. |
| `tags` | Extra chips (accreditation/refund; MODO cross-bank promos carry `{ adheredBanks: [...] }`). |
| `last_seen` | When the promo was last confirmed live. |

Detail (`GET /v1/promos/:id`) adds **`plans`** (per-plan breakdown: title,
payment methods, weekdays, dates, discount, installments) and **`raw`** (the
original source payload).

---

## 4. Filter recipes

```bash
# All promotions of one bank (across sources)
GET /v1/promos?issuer=Galicia&limit=30

# Supermarket promos, credit card, Wednesdays, ≥20% off
GET /v1/promos?category=SUPERMERCADOS&paymentMethod=CREDITO&weekday=WEDNESDAY&minDiscount=20

# Only the MODO hub feed
GET /v1/promos?provider=modo&page=1&limit=24

# Featured / highlighted promos for a hero row
GET /v1/promos?featured=true&limit=10
```

The `/filters` response gives you the exact allowed values for the dropdowns
(including the live `issuers` list), so the UI never hard-codes them.

---

## 5. Minimal fetch client (TypeScript)

```ts
const BASE = import.meta.env.VITE_PROMOS_API;      // https://<host>
const KEY  = import.meta.env.VITE_PROMOS_KEY;      // promos-scoped key

async function getPromos(params: Record<string, string | number> = {}) {
  const qs = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)]),
  );
  const res = await fetch(`${BASE}/v1/promos?${qs}`, {
    headers: { "X-API-Key": KEY },
  });
  if (!res.ok) throw new Error(`promos ${res.status}`);
  return res.json() as Promise<{
    data: PromoCard[];
    pagination: { page: number; limit: number; total: number; totalPages: number };
    meta: { ts: string };
  }>;
}

// filters once, then drive the grid from user selections
const { data: filters } = await (await fetch(`${BASE}/v1/promos/filters`, {
  headers: { "X-API-Key": KEY },
})).json();
const page1 = await getPromos({ issuer: "Macro", minDiscount: 20, limit: 24 });
```

---

## 6. Suggested layout (quick version)

1. **Left rail (filters):** provider, **bank (issuer)**, category, payment method,
   weekday, purchase mode, min-discount slider, "featured only" toggle. All values
   from `/filters`.
2. **Top bar:** search box → `merchant` param; result count from
   `pagination.total`; provider stat chips from `/providers`.
3. **Grid:** promo cards (`image_url`, `issuer` badge, `title`,
   `max_discount_pct`, payment/weekday chips, validity). Click → detail drawer
   (`/v1/promos/:id`, render `plans`).
4. **Pagination:** `page`/`limit` + `pagination.totalPages`.

Exact JSON shapes to code against live in
[`examples/api/promos-*.json`](../examples/api/) (`promos-list`, `promos-detail`,
`promos-filters`, `promos-providers`).

---

## 7. Refresh cadence

The scrape runs **weekly** (orchestrator cron `PROMOS_CRON`, Mondays 05:00 AR);
`last_seen` / `providers.lastRunAt` tell you freshness. Promos that drop off the
source become `is_active=false` (hidden by default via `activeOnly=true`), while
history is retained server-side in `promotion_snapshots`.
