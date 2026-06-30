# Scraper API Reference

REST API for the price scraping platform. JSON over HTTPS. All times in UTC ISO 8601.

> **Status**: v1, stable. Breaking changes will be released under `/v2/`.

---

## Base URL

| Environment | URL |
|---|---|
| Production | `https://api.megaanalytics.com/v1` *(once Phase 5 deploy lands)* |
| Local development | `http://localhost:3000/v1` |

---

## Frontend developer setup

Pick the option that matches where the backend is for you right now.

### Option A — Mocked data (fastest, recommended pre-deploy)

Build the entire frontend against static fixtures. **No backend needed**. The fixtures in this repo at [`examples/api/`](./examples/api/) match the real response envelopes one-to-one, so swapping to the live API later is a one-line change in the API client.

```ts
// During development, point your API client at the fixtures.
const USE_MOCKS = import.meta.env.DEV && !import.meta.env.VITE_API_BASE;

async function listProducts() {
  if (USE_MOCKS) return import('../../scraper/examples/api/products-list.json');
  const res = await fetch(`${API_BASE}/products`, { headers: { 'X-API-Key': KEY } });
  return res.json();
}
```

Each fixture covers a representative response — including edge cases like an out-of-stock snapshot, a degraded supermarket, and an alert with promotions. See [`examples/api/README.md`](./examples/api/README.md) for the index.

### Option B — Local API against shared Supabase

Run the API locally pointing at the same Supabase the team is using.

```bash
# In the scraper repo
cp .env.example .env       # fill in SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
npm install
npm run build
npm run apikey:create -- frontend-dev
# Save the printed key, then:
npm run dev:api
# API now listening at http://localhost:3000/v1
```

You'll get real data, but **no scrape pipeline** runs locally (no Redis). For the frontend that's fine — read-only API works without the orchestrator/worker.

### Option C — Deployed API

Once the API is deployed, point your frontend at `https://api.megaanalytics.com/v1` with a key issued via `npm run apikey:create -- frontend-prod`.

### CORS

The API is currently configured with `cors()` accepting **any origin** to make development trivial. Before launching the frontend in production, the operator will tighten this to the actual frontend domain — your code doesn't need to do anything about it.

### Recommended HTTP client

You don't need a heavy data-fetching library, but **TanStack Query** (`@tanstack/react-query`) pairs nicely with this API: it gives you caching, retries, pagination helpers, and request deduplication out of the box. The `pagination` envelope and stable resource IDs map cleanly to its query key conventions.

---

## Authentication

Every endpoint except `/health` requires an `X-API-Key` header.

```http
GET /v1/products HTTP/1.1
Host: api.yourdomain.com
X-API-Key: 693385619c033a55f022b6932b30b709db1b0c7388e57cc3a09ec1c6da73cbd6
```

Keys are issued out-of-band by the API operator. Each consumer (e.g., frontend, internal tool, partner) gets its own key. Keys are not OAuth tokens — they don't expire and don't refresh. Rotate them by issuing a new one and disabling the old one.

If a request lacks a valid key:

```json
HTTP/1.1 401 Unauthorized
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Missing X-API-Key header"
  }
}
```

---

## Response format

### Successful single-resource response

```json
{
  "data": { ... },
  "meta": { "ts": "2026-04-30T04:37:14.679Z" }
}
```

### Successful paginated list response

```json
{
  "data": [ ... ],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 1234,
    "totalPages": 25
  },
  "meta": { "ts": "2026-04-30T04:37:14.679Z" }
}
```

### Error response

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "Invalid query parameters",
    "details": [
      { "path": "limit", "message": "Number must be less than or equal to 200", "code": "too_big" }
    ]
  }
}
```

---

## Error codes

| HTTP | `code` | Meaning |
|---|---|---|
| 400 | `INVALID_REQUEST` | Bad query string, body, or path parameter |
| 401 | `UNAUTHORIZED` | Missing or invalid `X-API-Key` |
| 403 | `FORBIDDEN` | Valid key, but not allowed for this operation |
| 404 | `NOT_FOUND` | Resource does not exist |
| 409 | `CONFLICT` | State conflict (e.g., already resolved) |
| 429 | `RATE_LIMITED` | Too many requests *(reserved; not yet enforced)* |
| 500 | `INTERNAL` | Unexpected server error. Retry with backoff. |
| 503 | — | Returned by `/health` when the database is unreachable |

---

## Conventions

### Pagination

All list endpoints accept:

| Param | Type | Default | Max |
|---|---|---|---|
| `page` | int | `1` | — |
| `limit` | int | `50` | `200` |

The response always includes a `pagination` object with the total count so you can build pagers without extra requests.

### Date filters

Where supported, use ISO date strings (`YYYY-MM-DD`):

```
?from=2026-01-01&to=2026-04-30
```

`from` is inclusive at `00:00:00 UTC`. `to` is inclusive at `23:59:59 UTC`. Either can be omitted.

### Currency

Prices are in the currency reported by each supermarket (always `ARS` for now). The currency is included in every snapshot — never assume.

### Stock status

`in_stock` is a boolean. `null` is never returned (we treat unknown as `true` for visibility, with a record in `raw_data`). If a product is out of stock, the latest snapshot still has the **last seen price** so the historical record is preserved.

### Numbers, dates, and IDs

- **Prices** are JSON numbers (not strings) with up to 2 decimals (e.g. `2761.99`). Safe in `Number` for any realistic value. Always pair with the `currency` field.
- **Timestamps** are ISO 8601 in UTC (e.g. `2026-04-29T22:09:34.781Z`). `new Date(value)` parses them correctly in every browser.
- **IDs** are UUIDs (v4) for `products`, `supermarkets.id` (slug strings like `"coto"`), `supermarket_products`, `scrape_runs`, `alerts`. Snapshot `id` is a numeric `bigint` returned as a JSON number — don't try to do math on it, just use it as an opaque key.

### Image URLs

`product.metadata.imageUrl` (when present) points at the supermarket's own CDN, served over HTTPS, no auth required. You can put it directly in `<img src>`. Quality and dimensions vary by supermarket. Some products have no image — render a placeholder for that case.

### Metadata

`product.metadata` is a free-form JSON object. The keys vary by which supermarket originally seeded the product. The most consistent key across supermarkets is `imageUrl`. Don't rely on any other key being present; treat `metadata` as informational.

---

## TypeScript types

Copy-paste these into your frontend project (e.g. `src/types/api.ts`). They mirror the response shapes exactly. Frontends should ignore unknown extra fields — the API may add fields without a version bump.

```ts
// ============================================================================
// Response envelopes
// ============================================================================

export interface ApiSuccess<T> {
  data: T;
  meta: { ts: string };
}

export interface ApiPaginated<T> {
  data: T[];
  pagination: PageInfo;
  meta: { ts: string };
}

export interface ApiFailure {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: Array<{ path?: string; message: string; code?: string }>;
  };
}

export interface PageInfo {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export type ApiErrorCode =
  | 'INVALID_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'INTERNAL';

// ============================================================================
// Domain enums
// ============================================================================

export type HealthStatus = 'healthy' | 'degraded' | 'down' | 'unknown';
export type Tier         = 'api' | 'html' | 'ai' | 'manual' | 'marker';
export type RunStatus    = 'running' | 'completed' | 'failed';
export type ReviewStatus = 'pending_review' | 'published';
/** Per-snapshot outcome. 'scrape_failed' is internal-only (never in client_base). */
export type SnapshotStatus = 'ok' | 'out_of_stock' | 'not_found' | 'delisted' | 'scrape_failed';
export type LifecycleStatus = 'active' | 'out_of_stock' | 'delisted';

export type AlertSeverity = 'info' | 'warning' | 'critical';
export type AlertStatus   = 'open' | 'acknowledged' | 'resolved';
export type AlertType =
  | 'supermarket_degraded'
  | 'supermarket_unstable'
  | 'selector_broken'
  | 'rate_limited'
  | 'auth_required'
  | 'product_not_found'
  | 'price_missing'
  | 'price_anomaly'
  | 'stock_change';

export type PromotionType =
  | 'discount'
  | 'payment_method'
  | 'bundle'
  | 'loyalty'
  | 'unknown';

// ============================================================================
// Resources
// ============================================================================

export interface Product {
  id: string;                            // uuid
  name: string;
  category: string | null;
  brand: string | null;
  unit: string | null;                   // "500ml", "2 Litro", "1 Kg"
  ean: string | null;                    // barcode; cross-supermarket join key
  metadata: { imageUrl?: string } & Record<string, unknown>;
  created_at: string;                    // ISO 8601 UTC
  updated_at: string;
}

export interface Supermarket {
  id: string;                            // slug, e.g. "coto", "carrefour"
  name: string;
  is_active: boolean;
  base_url: string | null;
  health_status: HealthStatus;
  last_run_at: string | null;
  created_at: string;
  // Detail-only (returned by GET /supermarkets/:id)
  rate_limit_ms?: number;
  concurrency?: number;
  config?: Record<string, unknown>;
}

export interface Promotion {
  type: PromotionType;
  description: string;                   // human-readable; safe to render
  discountPct?: number;                  // e.g. 15 for "15% off"
  discountAmount?: number;
  validPaymentMethods?: string[];        // e.g. ["santander", "galicia"]
  raw?: unknown;                         // site-specific blob; don't depend on it
}

export interface Snapshot {
  id: number;                            // bigint, opaque key
  supermarket_product_id: string;        // uuid
  price: number;                         // current price the user pays
  list_price: number | null;             // crossed-out price; null if no discount
  unit_price: number | null;             // per-unit price (e.g. per liter)
  unit_price_per: string | null;         // unit label, e.g. "Litro", "Kg"
  in_stock: boolean;
  currency: string;                      // "ARS"
  tier_used: Tier;
  promotions: Promotion[];               // [] when no promos
  scraped_at: string;                    // ISO 8601 UTC
}

export interface SupermarketProductRow {
  supermarket_product_id: string;        // uuid
  external_id: string;                   // supermarket's own SKU
  external_url: string;                  // canonical product URL
  product: Product;
  latest_snapshot: Snapshot | null;      // null if never successfully scraped
}

export interface IngestResult {
  url: string;                           // URL as submitted
  canonical_url: string;                 // adapter-canonicalized URL stored in DB
  supermarket_id: string;
  supermarket_product_id: string;
  external_id: string;
  already_existed: boolean;              // true => idempotent re-add
  scrape: { status: 'success' | 'failed' | 'retry_scheduled' } | null;
}

export interface BulkImportResult {
  summary: { total: number; imported: number; skipped: number; failed: number };
  results: IngestResult[];               // successful registrations (new or already existed)
  failures: Array<{ url: string; error: string }>;
}

export interface CompareSummary {
  minPrice: number;
  maxPrice: number;
  avgPrice: number;
  supermarketsCount: number;
  inStockCount: number;
}

export interface CompareResultRow {
  supermarket_product_id: string;
  supermarket: Pick<Supermarket, 'id' | 'name'> & { healthStatus: HealthStatus };
  external_id: string;
  external_url: string;
  snapshot: Snapshot;
}

export interface CompareResult {
  product: Product;
  summary: CompareSummary | null;        // null when no in-stock prices
  results: CompareResultRow[];
}

export interface ScrapeRun {
  id: string;                            // uuid
  started_at: string;
  finished_at: string | null;
  status: RunStatus;                     // execution lifecycle
  review_status: ReviewStatus;           // publication lifecycle (client visibility)
  published_at: string | null;           // when an operator published the run
  total_jobs: number;
  succeeded: number;
  failed: number;
  retried: number;
  metadata?: Record<string, unknown>;
}

export interface RunBreakdown {
  bySupermarket: Record<string, { total: number; succeeded: number; failed: number }>;
  byTier: Partial<Record<Tier, number>>;
  topErrors: Array<{ type: string; count: number }>;
}

export interface RunProgress {
  total_jobs: number;
  distinct_started: number;
  completed: number;
  pending: number;
  succeeded: number;
  failed: number;
  running_or_retrying: number;
  retried_products: number;
  latest_activity_at: string | null;
  ms_since_latest_activity: number | null;
  by_supermarket: Record<
    string,
    { total: number; pending: number; running_or_retrying: number; succeeded: number; failed: number }
  >;
}

export interface RunDetail {
  run: ScrapeRun;
  breakdown: RunBreakdown;
}

export interface Alert {
  id: string;
  severity: AlertSeverity;
  type: AlertType;
  supermarket_id: string | null;
  product_id: string | null;
  title: string;
  message: string;
  context: Record<string, unknown>;      // shape varies per alert type
  status: AlertStatus;
  created_at: string;
  resolved_at: string | null;
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  uptimeSeconds: number;
  services: { db: boolean };
}
```

A small typed client (drop-in starting point):

```ts
const BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3000/v1';
const KEY  = import.meta.env.VITE_API_KEY  ?? '';

export class ApiError extends Error {
  constructor(public code: ApiErrorCode, public status: number, message: string) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'X-API-Key': KEY,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const body = await res.json();
  if (!res.ok) {
    const err = body as ApiFailure;
    throw new ApiError(err.error.code, res.status, err.error.message);
  }
  return body as T;
}

export const api = {
  listProducts: (q: { search?: string; page?: number; limit?: number } = {}) =>
    request<ApiPaginated<Product>>(
      `/products?${new URLSearchParams(q as Record<string, string>)}`,
    ),
  addProduct: (url: string, scrapeImmediately = false) =>
    request<ApiSuccess<IngestResult>>(`/products`, {
      method: 'POST',
      body: JSON.stringify({ url, scrape_immediately: scrapeImmediately }),
    }),
  bulkImportProducts: (urls: string[], scrapeImmediately = false) =>
    request<ApiSuccess<BulkImportResult>>(`/products/bulk-import`, {
      method: 'POST',
      body: JSON.stringify({ urls, scrape_immediately: scrapeImmediately }),
    }),
  getProduct: (id: string) =>
    request<ApiSuccess<Product>>(`/products/${id}`),
  compareProduct: (id: string) =>
    request<ApiSuccess<CompareResult>>(`/products/${id}/compare`),
  productHistory: (id: string, q: { from?: string; to?: string; limit?: number } = {}) =>
    request<ApiPaginated<Snapshot>>(
      `/products/${id}/history?${new URLSearchParams(q as Record<string, string>)}`,
    ),
  listSupermarkets: () =>
    request<ApiSuccess<Supermarket[]>>(`/supermarkets`),
  listAlerts: (q: { status?: AlertStatus; severity?: AlertSeverity } = {}) =>
    request<ApiPaginated<Alert>>(
      `/alerts?${new URLSearchParams(q as Record<string, string>)}`,
    ),
  ackAlert: (id: string) =>
    request<ApiSuccess<Alert>>(`/alerts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'acknowledged' }),
    }),
  // ...add the rest as you build pages
};
```

---

# Endpoints

## Health

### `GET /v1/health`

Liveness/readiness probe. **Public — no auth required.**

#### Response — 200

```json
{
  "data": {
    "status": "ok",
    "uptimeSeconds": 12345,
    "services": { "db": true }
  },
  "meta": { "ts": "..." }
}
```

Returns `503` with `status: "degraded"` if the database is unreachable.

---

## Products

A "product" represents a real-world item (e.g., *"Coca Cola 500ml"*) — distinct from any one supermarket's listing of it. The same product can be sold at multiple supermarkets, joined via `supermarket_products`. Master products are matched across supermarkets by EAN/barcode when available.

### `GET /v1/products`

List products with optional filters. Paginated.

#### Query

| Param | Type | Description |
|---|---|---|
| `page`, `limit` | int | Pagination |
| `search` | string | Case-insensitive substring of `name` |
| `category` | string | Exact match on `category` |
| `brand` | string | Exact match on `brand` |

#### Response — 200

```json
{
  "data": [
    {
      "id": "50bb31b8-5b6d-4a37-8905-ff3de2c6ffb9",
      "name": "Lavandina Original Ayudin 2l",
      "category": "Lavandinas Liquidas",
      "brand": "AYUDIN",
      "unit": "2 Litro",
      "ean": "7793253006709",
      "metadata": {
        "imageUrl": "https://.../00591050.jpg",
        "department": "LIMPIEZA"
      },
      "created_at": "2026-04-29T22:09:33.972Z",
      "updated_at": "2026-04-29T22:09:33.972Z"
    }
  ],
  "pagination": { "page": 1, "limit": 50, "total": 1, "totalPages": 1 },
  "meta": { "ts": "..." }
}
```

#### Example

```bash
curl -H "X-API-Key: <key>" \
  "https://api.yourdomain.com/v1/products?search=lavandina&limit=10"
```

---

### `POST /v1/products`

Add a new product URL to the scrape list. The supermarket is detected from the URL's hostname.

By default, this is a **lightweight registration** — the API probes the supermarket once to seed the master product record (name, brand, EAN, image), then returns. The product's first price snapshot is captured by the **next scheduled scrape run**, not by this call. Pass `scrape_immediately: true` if you want a snapshot right away (slower; ~1–3s extra).

The endpoint is **idempotent**: re-posting an already-imported URL returns `already_existed: true` and a `200` (instead of `201`).

#### Body

```json
{ "url": "https://www.cotodigital.com.ar/.../R-00012345-00012345-200" }
```

| Field | Type | Required | Description |
|---|---|---|---|
| `url` | string | yes | Full product URL on a supported supermarket |
| `scrape_immediately` | boolean | no | If `true`, also take a price snapshot synchronously. Default `false` |

#### Response — 201 Created (or 200 if already existed)

```json
{
  "data": {
    "url": "https://www.cotodigital.com.ar/.../R-00012345-00012345-200",
    "canonical_url": "https://www.cotodigital.com.ar/.../R-00012345-00012345-200",
    "supermarket_id": "coto",
    "supermarket_product_id": "8e9bcc71-...",
    "external_id": "00012345-00012345-200",
    "already_existed": false,
    "scrape": null
  },
  "meta": { "ts": "..." }
}
```

When `scrape_immediately: true`, the `scrape` field is an object like `{ "status": "success" }` (other values: `"failed"`, `"retry_scheduled"`).

#### Errors

- `400 INVALID_REQUEST` — bad URL, unsupported supermarket hostname, or the supermarket rejected the request (e.g., product not found / 404). The `message` field contains a human-readable explanation suitable for surfacing in the UI.

#### Example

```bash
curl -X POST -H "X-API-Key: <key>" -H "Content-Type: application/json" \
  -d '{"url":"https://www.cotodigital.com.ar/.../R-00012345-00012345-200"}' \
  https://api.yourdomain.com/v1/products
```

---

### `POST /v1/products/bulk-import`

Add many product URLs in one request. Same per-URL behavior as the single-URL endpoint above — fast registration by default, opt-in immediate scraping. Per-URL failures are collected in `failures` and the request itself returns 200 (it only 4xx's on input validation).

URLs are **deduped** within the request and processed **sequentially** so we respect each supermarket's rate limit.

#### Body

```json
{
  "urls": [
    "https://www.cotodigital.com.ar/.../R-00012345-00012345-200",
    "https://www.carrefour.com.ar/some-product/p"
  ]
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `urls` | string[] | yes | 1–25 URLs. Larger batches must be split client-side |
| `scrape_immediately` | boolean | no | Same meaning as on the single-URL endpoint. Default `false` |

#### Response — 200

```json
{
  "data": {
    "summary": { "total": 4, "imported": 2, "skipped": 1, "failed": 1 },
    "results": [
      {
        "url": "...",
        "canonical_url": "...",
        "supermarket_id": "coto",
        "supermarket_product_id": "...",
        "external_id": "...",
        "already_existed": false,
        "scrape": null
      }
    ],
    "failures": [
      { "url": "...", "error": "product_not_found: 404 from cotodigital JSON endpoint" }
    ]
  },
  "meta": { "ts": "..." }
}
```

`results` contains every URL that *registered successfully* (whether new or already existed). `failures` holds the rejects with the underlying error message.

#### Errors

- `400 INVALID_REQUEST` — empty array, more than 25 URLs, or any URL fails the URL/format check (the rest of the batch is **not** processed in that case)

---

### `GET /v1/products/:id`

Fetch a single master product by UUID.

#### Response — 200

Same shape as a list item above (single object in `data`, no `pagination`).

#### Errors
- `404 NOT_FOUND` — product does not exist

---

### `GET /v1/products/:id/compare`

The "best price across supermarkets" view for a single product. Returns the latest snapshot at every supermarket where the product is sold, plus a price summary.

#### Response — 200

```json
{
  "data": {
    "product": { "id": "...", "name": "..." },
    "summary": {
      "minPrice": 2599.00,
      "maxPrice": 2761.99,
      "avgPrice": 2680.50,
      "supermarketsCount": 2,
      "inStockCount": 2
    },
    "results": [
      {
        "supermarket_product_id": "8e9bcc71-...",
        "supermarket": {
          "id": "coto",
          "name": "Coto Digital",
          "healthStatus": "healthy"
        },
        "external_id": "00591050-00591050-200",
        "external_url": "https://www.cotodigital.com.ar/sitios/cdigi/productos/...",
        "snapshot": {
          "price": 2761.99,
          "list_price": null,
          "unit_price": 1381,
          "unit_price_per": "Litro",
          "in_stock": true,
          "currency": "ARS",
          "promotions": [],
          "scraped_at": "2026-04-29T22:09:34.781Z"
        }
      }
    ]
  },
  "meta": { "ts": "..." }
}
```

`summary` is `null` when no in-stock prices exist for the product.

#### Errors
- `404 NOT_FOUND` — product does not exist

---

### `GET /v1/products/:id/history`

Time series of price snapshots for a product. Useful for charts.

#### Query

| Param | Type | Description |
|---|---|---|
| `page`, `limit` | int | Pagination |
| `from`, `to` | date | Inclusive date range |
| `supermarket` | string | Filter to one supermarket (id) |

#### Response — 200 (paginated)

```json
{
  "data": [
    {
      "id": 1023,
      "supermarket_product_id": "8e9bcc71-...",
      "price": 2761.99,
      "list_price": null,
      "unit_price": 1381,
      "unit_price_per": "Litro",
      "in_stock": true,
      "currency": "ARS",
      "tier_used": "api",
      "promotions": [],
      "scraped_at": "2026-04-29T22:09:34.781Z"
    },
    {
      "id": 998,
      "supermarket_product_id": "8e9bcc71-...",
      "price": 2599.00,
      "list_price": 3200.00,
      "unit_price": 1299.50,
      "unit_price_per": "Litro",
      "in_stock": true,
      "currency": "ARS",
      "tier_used": "api",
      "promotions": [
        { "type": "discount", "description": "Hasta 35% off en productos seleccionados" },
        { "type": "payment_method", "description": "Tarjeta Carrefour 15%", "discountPct": 15 }
      ],
      "scraped_at": "2026-04-28T09:21:11.024Z"
    },
    {
      "id": 871,
      "supermarket_product_id": "8e9bcc71-...",
      "price": 2599.00,
      "list_price": null,
      "unit_price": null,
      "unit_price_per": null,
      "in_stock": false,
      "currency": "ARS",
      "tier_used": "api",
      "promotions": [],
      "scraped_at": "2026-04-22T09:15:08.331Z"
    }
  ],
  "pagination": { "page": 1, "limit": 50, "total": 30, "totalPages": 1 },
  "meta": { "ts": "..." }
}
```

Snapshots are returned in **descending** order by `scraped_at`. Note the variety in the example above: an unpromoted snapshot, one with a `list_price` (the crossed-out price) and active promotions, and one out-of-stock (where `in_stock: false` and `list_price`/`unit_price` are typically null).

---

## Supermarkets

### `GET /v1/supermarkets`

List all supermarkets with their health status. Not paginated — there are at most a few dozen.

#### Response — 200

```json
{
  "data": [
    {
      "id": "coto",
      "name": "Coto Digital",
      "is_active": true,
      "base_url": "https://www.cotodigital.com.ar",
      "health_status": "healthy",
      "last_run_at": "2026-04-30T09:32:14.000Z",
      "created_at": "2026-04-29T19:39:18.941Z"
    }
  ],
  "meta": { "ts": "..." }
}
```

`health_status` ∈ `{ "healthy", "degraded", "down", "unknown" }`. See *Alerts* for what each means.

---

### `GET /v1/supermarkets/:id`

Single supermarket including its scraping config.

#### Response — 200

Adds `rate_limit_ms`, `concurrency`, and `config` (free-form JSON, adapter-specific).

#### Errors
- `404 NOT_FOUND`

---

### `GET /v1/supermarkets/:id/products`

Products mapped to this supermarket, with their latest snapshot.

#### Query

| Param | Type | Description |
|---|---|---|
| `page`, `limit` | int | Pagination |
| `search` | string | Substring of product name |
| `in_stock` | `"true"` \| `"false"` | Filter by latest stock status |

#### Response — 200 (paginated)

```json
{
  "data": [
    {
      "supermarket_product_id": "8e9bcc71-...",
      "external_id": "00591050-00591050-200",
      "external_url": "https://...",
      "product": {
        "id": "50bb31b8-...",
        "name": "Lavandina Original Ayudin 2l",
        "brand": "AYUDIN",
        "category": "Lavandinas Liquidas",
        "unit": "2 Litro",
        "ean": "7793253006709",
        "metadata": { "imageUrl": "..." }
      },
      "latest_snapshot": {
        "price": 2761.99,
        "in_stock": true,
        "currency": "ARS",
        "scraped_at": "2026-04-29T22:09:34.781Z",
        "promotions": []
      }
    }
  ],
  "pagination": { ... },
  "meta": { "ts": "..." }
}
```

---

## Snapshots

The lower-level price feed. For typical product views, prefer `/products/:id/history`.

### `GET /v1/snapshots`

#### Query

| Param | Type | Description |
|---|---|---|
| `page`, `limit` | int | Pagination |
| `supermarket` | string | Supermarket id |
| `product` | uuid | Master product id |
| `supermarket_product` | uuid | Specific mapping row id |
| `from`, `to` | date | Date range |
| `in_stock` | `"true"` \| `"false"` | Filter by stock status |

`supermarket` and `product` filters can be combined.

#### Response — 200 (paginated)

Items have the same shape as items in `/products/:id/history`.

---

### `POST /v1/snapshots/manual`

Operator override: insert a trusted manual price snapshot when scraping failed but the price was manually verified.

#### Body

```json
{
  "supermarket_product_id": "...",
  "scrape_run_id": "...",
  "price": 1234.56,
  "list_price": null,
  "unit_price": null,
  "unit_price_per": null,
  "in_stock": true,
  "currency": "ARS",
  "promotions": [],
  "note": "Verified from supermarket website"
}
```

Only `supermarket_product_id` and `price` are required. The inserted row uses `tier_used: "manual"`.

---

## Runs

A *run* is a single orchestration cycle (typically once per day). Each run enqueues N jobs; each job becomes one row in `job_executions` and (on success) one row in `price_snapshots`.

### `GET /v1/runs`

List recent scrape runs. Most recent first.

#### Response — 200 (paginated)

```json
{
  "data": [
    {
      "id": "...",
      "started_at": "2026-04-30T09:00:00.000Z",
      "finished_at": "2026-04-30T09:32:14.000Z",
      "status": "completed",
      "total_jobs": 3000,
      "succeeded": 2847,
      "failed": 153,
      "retried": 0,
      "metadata": {}
    }
  ],
  "pagination": { ... },
  "meta": { "ts": "..." }
}
```

`status` ∈ `{ "running", "completed", "failed" }`.

---

### `GET /v1/runs/:id`

Detailed breakdown of a single run.

#### Response — 200

```json
{
  "data": {
    "run": {
      "id": "...",
      "started_at": "...",
      "finished_at": "...",
      "status": "completed",
      "total_jobs": 3000,
      "succeeded": 2847,
      "failed": 153,
      "retried": 0
    },
    "breakdown": {
      "bySupermarket": {
        "coto":      { "total": 100, "succeeded": 100, "failed": 0 },
        "carrefour": { "total": 100, "succeeded": 98,  "failed": 2 }
      },
      "byTier":    { "api": 2700, "html": 145, "ai": 2, "manual": 0 },
      "topErrors": [
        { "type": "selector_failed", "count": 89 },
        { "type": "network_timeout", "count": 31 }
      ]
    }
  },
  "meta": { "ts": "..." }
}
```

#### Errors
- `404 NOT_FOUND`

---

### `GET /v1/runs/:id/progress`

Live progress for a running or recently completed run. Use this for the operations dashboard while the scraper is still active.

#### Response — 200

```json
{
  "data": {
    "run": { "id": "...", "status": "running", "total_jobs": 3000 },
    "progress": {
      "total_jobs": 3000,
      "distinct_started": 2800,
      "completed": 2700,
      "pending": 200,
      "succeeded": 2640,
      "failed": 60,
      "running_or_retrying": 100,
      "retried_products": 12,
      "latest_activity_at": "2026-04-30T09:32:14.000Z",
      "ms_since_latest_activity": 12000,
      "by_supermarket": {
        "carrefour": {
          "total": 100,
          "pending": 0,
          "running_or_retrying": 2,
          "succeeded": 90,
          "failed": 8
        }
      }
    }
  },
  "meta": { "ts": "..." }
}
```

---

### `GET /v1/runs/:id/failures`

Paginated product-level failure drilldown.

#### Query

| Param | Type | Description |
|---|---|---|
| `page`, `limit` | int | Pagination |
| `supermarket` | string | Filter failures to one supermarket |
| `error_type` | string | Filter failures to one error type |

#### Response — 200

Each item includes the failed final attempt, supermarket/product metadata, URL, and latest known snapshot.

---

### `POST /v1/runs/:id/retry-failed`

Creates a new recovery run from failed products in the source run.

#### Body

```json
{
  "supermarket": "carrefour",
  "error_type": "network_timeout",
  "supermarket_product_ids": ["..."],
  "max": 500
}
```

All body fields are optional. If `supermarket_product_ids` is present, only those mappings are retried.

#### Response — 201

```json
{
  "data": {
    "source_run_id": "...",
    "retry_run_id": "...",
    "total_enqueued": 12,
    "by_supermarket": { "carrefour": 12 }
  },
  "meta": { "ts": "..." }
}
```

If nothing matches, `retry_run_id` is `null` and `total_enqueued` is `0`.

---

### `GET /v1/runs/:id/review`

Coverage summary + the unresolved **gap list** for the daily-review screen. A gap
is a product that failed and was not fixed by a re-run or a manual price.

#### Response — 200

```json
{
  "data": {
    "run": { "id": "...", "status": "completed", "review_status": "pending_review",
             "started_at": "...", "finished_at": "...", "total_jobs": 200, "published_at": null },
    "coverage": { "expected": 200, "succeeded": 196, "resolved_by_fix": 1, "gaps": 3, "coveragePct": 98.5 },
    "bySupermarket": [
      { "supermarket_id": "carrefour", "total": 50, "succeeded": 48, "failed": 2, "gaps": 1 }
    ],
    "gaps": [
      { "supermarket_product_id": "...", "supermarket_id": "carrefour", "ean": "...",
        "name": "...", "external_url": "...", "error_type": "selector_failed",
        "error_message": "...", "lifecycle_status": "active", "resolved_status": "scrape_failed" }
    ],
    "recovery_run_ids": ["..."]
  },
  "meta": { "ts": "..." }
}
```

`resolved_status` is the marker status the gap would get if published as-is.

---

### `POST /v1/runs/:id/publish`

Reconcile remaining gaps (insert one no-price marker row each) and flip the run —
plus any recovery runs spawned from it — to `published`, making the day visible in
the client `client_base` feed. Idempotent: re-publishing only fills new gaps.

#### Body

```json
{ "force": false }
```

With unresolved gaps and `force: false`, returns **409 CONFLICT** (`details.gaps`
holds the count) so the UI can prompt "publish anyway?". With `force: true` (or no
gaps), publishes and any leftover gaps become `scrape_failed` markers (internal,
hidden from the client).

#### Response — 200

```json
{
  "data": { "published": true, "markers_inserted": 3,
            "published_run_ids": ["...", "..."], "published_at": "..." },
  "meta": { "ts": "..." }
}
```

---

### `POST /v1/runs/:id/snapshots/flag`

Mark specific products in this run with a no-price, real-world status.

#### Body

```json
{
  "status": "out_of_stock",
  "supermarket_product_ids": ["...", "..."],
  "note": "Confirmed OOS on site",
  "set_lifecycle": true
}
```

`status` ∈ `{ "out_of_stock", "not_found", "delisted" }`. When `set_lifecycle` is
true and `status` is `out_of_stock`/`delisted`, the product's mapping lifecycle is
pinned so future runs auto-emit the same marker.

#### Response — 200

```json
{ "data": { "inserted": 2, "lifecycle_updated": 2 }, "meta": { "ts": "..." } }
```

---

## Supermarket products

### `PATCH /v1/supermarket-products/:id/lifecycle`

Set a product's durable lifecycle at a chain, independent of any run.

#### Body

```json
{ "lifecycle_status": "delisted", "note": "Discontinued by Carrefour" }
```

`lifecycle_status` ∈ `{ "active", "out_of_stock", "delisted" }`.

#### Response — 200

```json
{
  "data": { "id": "...", "supermarket_id": "carrefour", "external_id": "...",
            "external_url": "...", "lifecycle_status": "delisted",
            "lifecycle_note": "Discontinued by Carrefour",
            "lifecycle_changed_at": "..." },
  "meta": { "ts": "..." }
}
```

#### Errors
- `404 NOT_FOUND` — mapping does not exist

---

## Alerts

Anything the system thinks needs human attention: a supermarket with high failure rate, a redesigned page, etc.

### `GET /v1/alerts`

List alerts.

#### Query

| Param | Type | Description |
|---|---|---|
| `page`, `limit` | int | Pagination |
| `status` | `"open"` \| `"acknowledged"` \| `"resolved"` | |
| `severity` | `"info"` \| `"warning"` \| `"critical"` | |
| `supermarket` | string | Filter by supermarket id |

#### Response — 200 (paginated)

```json
{
  "data": [
    {
      "id": "...",
      "severity": "critical",
      "type": "supermarket_degraded",
      "supermarket_id": "carrefour",
      "product_id": null,
      "title": "Carrefour degraded",
      "message": "97/100 products failing. Top errors: selector_failed (89), 404 (8)",
      "context": {
        "run_id": "...",
        "failure_rate": "97%",
        "total": 100,
        "succeeded": 3,
        "failed": 97,
        "top_errors": "selector_failed (89), 404 (8)"
      },
      "status": "open",
      "created_at": "2026-04-30T09:32:14.000Z",
      "resolved_at": null
    }
  ],
  "pagination": { ... },
  "meta": { "ts": "..." }
}
```

#### Severity levels

| Severity | Meaning |
|---|---|
| `critical` | Action required. Telegram notification fires. Site degraded. |
| `warning` | Possible issue worth investigating. |
| `info` | Non-urgent context (price anomaly, individual stock change). |

#### Alert types

| Type | Trigger |
|---|---|
| `supermarket_degraded` | ≥80% of products failing on a supermarket |
| `supermarket_unstable` | 30–80% failure rate |
| `selector_broken` | High failure rate dominated by `selector_failed` errors |
| `rate_limited` | High failure rate dominated by HTTP 429s |
| `auth_required` | Site started requiring login |
| `product_not_found` | Individual product gone (HTTP 404) |
| `price_missing` | Page loaded but price couldn't be parsed |
| `price_anomaly` | Price changed >50% overnight *(reserved, not yet emitted)* |
| `stock_change` | Stock status flipped *(reserved, not yet emitted)* |

---

### `PATCH /v1/alerts/:id`

Transition an alert's status. Idempotent.

#### Body

```json
{ "status": "acknowledged" }
```
or
```json
{ "status": "resolved" }
```

#### Response — 200

The full updated alert (same shape as list items above). `resolved_at` is set automatically when transitioning to `resolved`.

#### Errors
- `400 INVALID_REQUEST` — `status` not in `{ "acknowledged", "resolved" }`
- `404 NOT_FOUND`

---

## Revistas (magazine review)

Operator-facing review for chains whose promos only exist in a weekly/bi-weekly
**magazine** (a PDF or online flipbook). The daily run detects a new issue, reads
it with vision AI, matches products against the catalog, and queues them for human
approval. Approving an item writes a `supermarket_products` mapping + a
`price_snapshots` row (`tier_used: "ai"`) tied to the day's run — so it publishes
through the normal gate. Nothing reaches the client until a person approves it.

> **Full spec (UI flow, modal, types, edge cases):**
> [`docs/REVISTA_REVIEW.md`](./docs/REVISTA_REVIEW.md). Fixtures:
> `examples/api/revistas-pending.json`, `revista-items.json`, `revista-approve.json`.

### `GET /v1/revistas/pending`

Magazines awaiting review (drives the modal/badge in the Daily Review screen).
Returns an array of magazine headers, each with a `counts` breakdown
(`total`/`pending`/`approved`/`rejected`). See `examples/api/revistas-pending.json`.

### `GET /v1/revistas/:magazineId`

A single magazine header + counts (same item shape as `pending`).

### `GET /v1/revistas/:magazineId/items`

The review queue, paginated. Each item carries the `page_image_url` (public
Supabase Storage URL), the AI's `extracted` fields, the `proposed_match` (or
`null`), a `confidence` (0–1), `method` (`ean` | `llm` | `manual`), and the
judge `reason`. See `examples/api/revista-items.json`.

| Param | Type | Description |
|---|---|---|
| `page`, `limit` | int | Pagination |
| `status` | `pending` \| `approved` \| `rejected` | Filter |
| `page_number` | int | Only items read from a given magazine page |

### `POST /v1/revistas/items/:itemId/approve`

Approve a queued item → mapping + snapshot. Body (all optional; omit to accept
the AI's values): `product_id` (override the match — catalog product), `price`,
`promo_price`, `promo_text`, `note`, `reviewed_by`. See
`examples/api/revista-approve.json`.

Errors: `400 INVALID_REQUEST` (no proposed match and no `product_id`, or no
price), `404 NOT_FOUND`, `409 CONFLICT` (already reviewed).

### `POST /v1/revistas/items/:itemId/reject`

Discard an item. Body: `{ "note"?, "reviewed_by"? }`. Errors: `404`, `409`.

### `POST /v1/revistas/:magazineId/items`

Manually add a product the AI missed. Body: `page_number` (int, required),
`product_id` (existing catalog product, required), `price` (required),
`promo_price?`, `promo_text?`, `note?`, `reviewed_by?`. Creates an `approved`,
`method: "manual"` item + mapping + snapshot. Response shape = `approve`.

### `POST /v1/revistas/:magazineId/finalize`

Mark the magazine reviewed (drops it from `pending`, resolves the
`revista_review` alert). Body: `{ "force"?: boolean }` — `force: true` finalizes
with items still `pending`. Returns `{ magazine_id, status, approved, rejected, pending }`.
Errors: `409 CONFLICT` when items are still pending and `force` is not set.

---

## Quickstart

### cURL

```bash
KEY="your-api-key"
BASE="https://api.yourdomain.com/v1"

# 1. Find a product
curl -H "X-API-Key: $KEY" "$BASE/products?search=coca&limit=5"

# 2. Compare prices for that product across supermarkets
curl -H "X-API-Key: $KEY" "$BASE/products/<id>/compare"

# 3. Last 30 days of price history
curl -H "X-API-Key: $KEY" "$BASE/products/<id>/history?from=2026-04-01&limit=200"
```

### JavaScript (browser / Node)

```js
const KEY = '...';
const BASE = 'https://api.yourdomain.com/v1';

async function listProducts(search) {
  const url = new URL(`${BASE}/products`);
  if (search) url.searchParams.set('search', search);
  const res = await fetch(url, { headers: { 'X-API-Key': KEY } });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(`${err.error.code}: ${err.error.message}`);
  }
  return res.json(); // { data, pagination, meta }
}

async function compare(productId) {
  const res = await fetch(`${BASE}/products/${productId}/compare`, {
    headers: { 'X-API-Key': KEY },
  });
  return res.json();
}
```

---

## Common UI workflows

Recipes for the typical screens. Each one lists the calls you need and what to combine where.

### Product detail page

The classic layout: header, comparison table, history chart.

```
GET /v1/products/:id           → product header (name, brand, image)
GET /v1/products/:id/compare   → "available at N supermarkets" table
GET /v1/products/:id/history?from=YYYY-MM-DD   → chart data
```

Fire the three calls in parallel — they don't depend on each other. Show skeleton states for the slowest.

### Product search & list

```
GET /v1/products?search=<q>&page=<n>&limit=20
```

The `pagination` envelope gives you `total` and `totalPages` upfront, so you can render "Showing 1-20 of 347" without a separate count query.

For "infinite scroll" patterns, page through with the same query and append `data` arrays. For numbered pagination, just use `pagination.page`.

### Supermarket overview / health dashboard

```
GET /v1/supermarkets
```

Single call. The `health_status` field on each row drives the badge color:

| `health_status` | Badge | Meaning |
|---|---|---|
| `healthy` | green | Last run had <30% failure rate |
| `degraded` | yellow | Last run had 30–80% failure rate |
| `down` | red | Last run had >80% failure rate, or hasn't run |
| `unknown` | gray | Never run yet |

`last_run_at` is your "last updated" timestamp.

### Alert inbox

```
GET /v1/alerts?status=open                       → unread badge count + list
PATCH /v1/alerts/:id  { "status": "acknowledged" }  → on user click
GET /v1/alerts?status=open                       → re-fetch after PATCH
```

If you're using TanStack Query: invalidate the `['alerts', { status: 'open' }]` query key after the PATCH and it'll refetch automatically.

### Recent runs / scrape activity log

```
GET /v1/runs?limit=10            → timeline list
GET /v1/runs/:id                 → expand into detail view (per-supermarket breakdown)
```

The `breakdown.bySupermarket` map is perfect for a stacked bar chart of success/failure per site.

### Add a product to the scrape list

Single URL — typical "paste URL, click add" UI:

```
POST /v1/products  { "url": "..." }
```

The supermarket is detected from the hostname. The new product is registered immediately but the **first price snapshot only appears after the next daily scrape run** (around 06:00 ART). If you need an instant snapshot for the UX, send `{ "url": "...", "scrape_immediately": true }` (adds ~1–3s of latency).

For "paste a list" UIs, use `POST /v1/products/bulk-import` with up to 25 URLs at once. Anything bigger should be chunked client-side:

```ts
async function addMany(urls: string[]) {
  const CHUNK = 25;
  for (let i = 0; i < urls.length; i += CHUNK) {
    await api.bulkImportProducts(urls.slice(i, i + CHUNK));
  }
}
```

After a successful add, invalidate the `['products']` and (if shown) the `['supermarkets', id, 'products']` query keys to refresh the list views.

### Cross-supermarket compare table

When you have a product UUID and want a "Where to buy" table:

```
GET /v1/products/:id/compare
```

The response's `summary` block gives you the headline numbers (`minPrice`, `maxPrice`, savings) so you don't have to compute them client-side. `summary` is `null` when no in-stock prices exist — show an "out of stock everywhere" empty state.

---

## Refresh cadence

Scrape data updates **once per day** (around 06:00 ART). There's no benefit to polling more often than every few minutes for product/snapshot data. Reasonable defaults if you're using TanStack Query or SWR:

| Resource | `staleTime` | `refetchInterval` |
|---|---|---|
| Products, supermarkets, snapshots | 5 min | none |
| Compare/history (product detail) | 5 min | none |
| Alerts | 30 sec | 30 sec (only when alert page is visible) |
| Runs | 1 min | 1 min (only on activity page) |

`/v1/health` is the only endpoint worth polling continuously (e.g. every 30s) for an "API status" indicator.

---

## Versioning

The path prefix `/v1/` is the API version. Breaking changes will be released under a new prefix (`/v2/`); v1 will continue to work for at least 6 months after v2 ships.

Non-breaking additions (new optional fields, new endpoints) happen on v1 without notice. Frontends should ignore unknown fields.

---

## Rate limits

Currently no enforced rate limit. Be reasonable — especially when paginating large datasets, prefer `limit=200` with fewer requests over `limit=1` with many. A per-key rate limit may be enabled in the future via the existing `api_keys.rate_limit` column.

---

## Operational notes

- Daily scrape runs around **06:00 UTC-3** (Buenos Aires). Snapshot timestamps reflect when each individual product was scraped, not when the run started.
- A given product may have multiple snapshots per day if a scrape is retried after a transient failure.
- `tier_used` indicates how the data was obtained: `"api"` (structured API call), `"html"` (HTML/Playwright scrape), `"ai"` (AI-assisted extraction). Most snapshots are `"api"`.
- `raw_data` (in detail responses) preserves the supermarket-specific blob the adapter captured. Useful for debugging, but the schema is unstable — frontends should not rely on it.
