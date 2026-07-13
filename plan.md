# Scraper Service — Build Plan

A price scraping platform that monitors products across multiple supermarkets daily, stores price history, and exposes everything through a secure REST API.

This plan is the source of truth. Update it as decisions evolve.

---

## 1. Tech stack & key decisions

| Decision | Choice | Why |
|---|---|---|
| Language | **TypeScript** (strict mode) | Catches errors at compile time; the adapter pattern is much safer with types. |
| Runtime | Node.js 20 LTS | Standard, stable. |
| HTTP framework | Express | Simple, well-known. |
| Queue | BullMQ on Redis | Persistent, handles retries/delays/rate limits/concurrency. |
| Redis hosting | **Local on EC2** | One less external service to manage. Free. Fast. Persists to disk. |
| Database | Supabase (Postgres) | Already provisioned. |
| HTTP scraping | Native `fetch` / `undici` | Built into Node 20. |
| Browser scraping | Playwright | Best for hostile sites. |
| AI scraping (Tier 3) | **Skip for MVP** | Build only when real failure data shows it's worth the cost. |
| Process manager | PM2 | Auto-restarts, survives reboots, multi-process. |
| Reverse proxy + HTTPS | **Caddy** | Auto-HTTPS via Let's Encrypt. ~4 lines of config. |
| Logging | `pino` (structured JSON) | Fast, machine-readable. |
| Error tracking | **Sentry** (free tier) | Captures unhandled exceptions with full context. |
| Alert notifications | **Telegram bot** | Instant on phone, free, easy to set up. |
| Validation | `zod` | Schema validation for adapter outputs + API inputs. |
| CI/CD | GitHub Actions → SSH → `pm2 reload` | Push to `main` → live in ~60s. |

---

## 2. Configuration strategy

**Hybrid: code for structure, database for runtime values.**

```
IN CODE (requires git push to change):
  ├─ Adapters (one .ts file per supermarket — the actual scraping logic)
  └─ TypeScript interfaces (what fields a product has, what a scrape returns)

IN DATABASE (change anytime, no deploy):
  ├─ Which supermarkets are active/inactive (toggle)
  ├─ Per-supermarket: rate limits, concurrency, base URLs
  ├─ Which products to scrape per supermarket (SKU lists)
  ├─ Master product catalog
  └─ Per-supermarket selectors (override what's hardcoded if needed)
```

Implications:

- **Adding a new product**: insert a row in DB. ~10 seconds.
- **Pausing SuperX while it's broken**: flip `is_active = false`. No deploy.
- **Tweaking rate limit**: update one DB column.
- **Adding a new supermarket**: write 1 adapter file + 1 DB row, deploy.
- **Fields might change**: master `products` table has strict columns for common stuff + a JSONB `metadata` column for anything else. No migrations needed for new fields.

---

## 3. Database schema

```sql
-- Master catalog: one row per "real" product
products (
  id              uuid PK
  name            text       -- "Coca Cola 500ml"
  category        text       -- "beverages"
  brand           text
  unit            text       -- "500ml"
  ean             text       -- barcode, indexed; cross-supermarket join key
  metadata        jsonb      -- flexible fields (image_url, ingredients, etc.)
  created_at      timestamptz
  updated_at      timestamptz
)
CREATE INDEX ON products (ean) WHERE ean IS NOT NULL;

-- Supermarket configs (the runtime-configurable part)
supermarkets (
  id              text PK    -- "superx"
  name            text       -- "SuperX"
  is_active       bool       -- pause/resume without deploy
  base_url        text
  rate_limit_ms   int
  concurrency     int
  config          jsonb      -- adapter-specific stuff (auth tokens, selectors, etc.)
  health_status   text       -- "healthy" | "degraded" | "down"
  last_run_at     timestamptz
  created_at      timestamptz
)

-- The mapping: this product exists at this supermarket with this SKU
supermarket_products (
  id                  uuid PK
  supermarket_id      text FK
  product_id          uuid FK     -- links to master
  external_id         text        -- their SKU
  external_url        text        -- product page URL
  is_active           bool
  metadata            jsonb       -- per-mapping config
  created_at          timestamptz
  UNIQUE (supermarket_id, external_id)
)

-- The core data table — one row per product per scrape
price_snapshots (
  id                          bigserial PK
  supermarket_product_id      uuid FK
  scraped_at                  timestamptz
  price                       numeric(10,2)    -- consumer pays this
  list_price                  numeric(10,2)    -- crossed-out / before-discount price (nullable)
  unit_price                  numeric(10,2)    -- per-unit price (nullable)
  unit_price_per              text             -- "Litro", "Kg", "100g", etc. (nullable)
  in_stock                    bool
  currency                    text             -- "ARS"
  tier_used                   text             -- "api" | "html" | "ai"
  promotions                  jsonb            -- array of detected promos, see shape below
  raw_data                    jsonb            -- full raw response for forensics
  scrape_run_id               uuid FK
)
CREATE INDEX ON price_snapshots (supermarket_product_id, scraped_at DESC);

-- Price semantics (IMPORTANT):
--   `price`      = the CURRENT SELLING price (already discounted when on sale).
--                  This is the canonical number used by history/alerts/compare.
--   `list_price` = the REGULAR / crossed-out price, set only when there's a
--                  markdown (price < list_price). Every VTEX store uses this
--                  pattern (e.g. Cordiez: list_price 4362.12, price 2999).
-- The client-facing `client_base` view (migration 002, fixed in 003) maps these
-- to the client's columns: Precio_Regular = COALESCE(list_price, price),
-- Precio_c_Oferta_1 = the sale price when marked down, and Descuento_Unitario =
-- max(named-promo discount, markdown gap). Do NOT change `price` to mean the
-- regular price — the regular/offer split is a view concern only.

-- promotions JSONB shape (array of objects, each object normalized):
-- [
--   {
--     "type": "discount" | "payment_method" | "bundle" | "loyalty" | "unknown",
--     "description": "20% off with Galicia card",
--     "discount_pct": 20,           -- nullable
--     "discount_amount": null,      -- nullable
--     "valid_payment_methods": ["galicia"], -- nullable
--     "raw": { ... }                -- original supermarket-specific blob, for forensics
--   }
-- ]

-- One row per daily orchestration run
scrape_runs (
  id              uuid PK
  started_at      timestamptz
  finished_at     timestamptz
  status          text       -- "running" | "completed" | "failed"
  total_jobs      int
  succeeded       int
  failed          int
  retried         int
  metadata        jsonb
)

-- Every individual job execution (success or failure)
job_executions (
  id                          uuid PK
  scrape_run_id               uuid FK
  supermarket_product_id      uuid FK
  attempt                     int        -- 1, 2, 3
  tier_used                   text
  status                      text       -- "success" | "failed" | "retrying"
  error_type                  text       -- "timeout" | "404" | "selector_failed" | etc.
  error_message               text
  error_stack                 text
  duration_ms                 int
  started_at                  timestamptz
  finished_at                 timestamptz
)
CREATE INDEX ON job_executions (scrape_run_id, status);

-- Everything that needs human attention
alerts (
  id              uuid PK
  severity        text       -- "info" | "warning" | "critical"
  type            text       -- "supermarket_degraded" | "selector_broken" | "price_anomaly" | etc.
  supermarket_id  text FK    -- nullable
  product_id      uuid FK    -- nullable
  title           text
  message         text
  context         jsonb      -- error details, stats, etc.
  status          text       -- "open" | "acknowledged" | "resolved"
  created_at      timestamptz
  resolved_at     timestamptz
)

-- API access keys
api_keys (
  id              uuid PK
  name            text       -- "frontend", "internal-test"
  key_hash        text       -- bcrypt hash, never store plaintext
  is_active       bool
  rate_limit      int        -- requests per minute
  created_at      timestamptz
  last_used_at    timestamptz
)

-- Revista (magazine) review layer — migration 006. For chains whose promos
-- only exist in a weekly/bi-weekly PDF/flipbook (Makro, Vital, Rosental,
-- Maxicomodín). Flagged via supermarkets.config = { source_type: 'revista',
-- revista: { strategy, offersUrl, pubhtml5Url? } }. See docs/REVISTA_REVIEW.md
-- and src/revistas/. An APPROVED item writes a normal price_snapshots row
-- (tier_used='ai', status='ok') tied to the day's run, so it publishes through
-- the existing gate — nothing magazine-specific in client_base.
revista_magazines (
  id               uuid PK
  supermarket_id   text FK
  label            text
  source_strategy  text        -- 'html-pdf-links' | 'pubhtml5' | 'publuu'
  source_url       text
  content_hash     text        -- dedup key (cheap: URL + size); unchanged issue = no AI cost
  file_size        bigint
  page_count       int
  status           text        -- 'processing' | 'in_review' | 'reviewed'
  scrape_run_id    uuid FK
  metadata         jsonb       -- { matched, total, page_images:[{page,url}], analysis:[{page,extracted,matched,method,confidence,reason,matched_product_id,top_candidates}] }
                               -- ALL pages are uploaded + ALL extracted products (matched or not) recorded here.
                               -- Powers the debug/analyze view (GET /v1/revistas/:id/analysis, docs/REVISTA_DEBUG.md).
  detected_at      timestamptz
  reviewed_at      timestamptz
  UNIQUE (supermarket_id, content_hash)
)

-- The human review queue: one row per (AI-extracted product → proposed match).
revista_review_items (
  id                                uuid PK
  magazine_id                       uuid FK
  supermarket_id                    text FK
  page_number                       int
  page_image_url                    text         -- public Supabase Storage URL
  extracted                         jsonb        -- { name, brand, ean, price, promo_price, promo_text, quantity }
  proposed_product_id               uuid FK      -- nullable (manual / no proposal)
  confidence                        numeric(4,3) -- 0..1 (1.0 for EAN matches)
  method                            text         -- 'ean' | 'llm' | 'manual'
  reason                            text
  candidates                        jsonb
  status                            text         -- 'pending' | 'approved' | 'rejected'
  note                              text
  reviewed_by                       text
  reviewed_at                       timestamptz
  resulting_supermarket_product_id  uuid FK      -- set on approve
  resulting_snapshot_id             bigint       -- set on approve
  created_at                        timestamptz
)
```

---

## 4. The adapter contract

The heart of the engine. Every supermarket implements this:

```ts
// src/adapters/types.ts
export interface ScrapeContext {
  supermarketProductId: string;
  externalId: string;
  externalUrl?: string;          // canonical URL (no scraping params)
  config: SupermarketConfig;     // from DB
  logger: Logger;
}

export interface Promotion {
  type: 'discount' | 'payment_method' | 'bundle' | 'loyalty' | 'unknown';
  description: string;
  discountPct?: number;
  discountAmount?: number;
  validPaymentMethods?: string[];
  raw?: unknown;                 // original site-specific blob
}

export interface ScrapeResult {
  price: number;
  listPrice?: number;            // crossed-out / "before discount" price
  unitPrice?: number;            // per-unit price (e.g., per liter)
  unitPricePer?: string;         // unit label ("Litro", "Kg", "100g")
  inStock: boolean;
  currency: string;
  tierUsed: 'api' | 'html' | 'ai';
  promotions?: Promotion[];
  productInfo?: {                // extracted master-catalog data (optional)
    name?: string;
    brand?: string;
    category?: string;
    unit?: string;
    ean?: string;
    imageUrl?: string;
    metadata?: Record<string, unknown>;
  };
  rawData?: Record<string, unknown>;
}

export interface SupermarketAdapter {
  id: string;
  /** Convert any URL into the canonical, user-facing URL (no scraping params) */
  canonicalizeUrl?(url: string): string;
  scrape(ctx: ScrapeContext): Promise<ScrapeResult>;
}
```

**Canonical URL handling**: the adapter knows how to convert between the user-facing URL (stored in DB) and whatever it needs internally. For Coto, `canonicalizeUrl` strips `?format=json`, and `scrape` re-adds it before fetching. The DB always stores the clean URL.

Example with internal fallback:

```ts
// src/adapters/superx.ts
export const superxAdapter: SupermarketAdapter = {
  id: 'superx',
  async scrape(ctx) {
    try {
      return await tryApi(ctx);
    } catch (apiErr) {
      ctx.logger.warn({ err: apiErr }, 'API failed, falling back to HTML');
      return await tryHtml(ctx);
    }
  },
};
```

The worker code is generic:

```ts
const adapter = adapters[supermarketId];
const result = await adapter.scrape(ctx);
await saveSnapshot(result);
```

**Adding a new supermarket = writing one file. The engine never changes.**

---

## 5. Project structure

```
scraper/
├── .github/
│   └── workflows/
│       └── deploy.yml
├── src/
│   ├── index.ts                  # Entry point, picks process based on env
│   ├── orchestrator/
│   │   ├── index.ts              # Cron, enqueues all daily jobs
│   │   └── schedule.ts
│   ├── worker/
│   │   ├── index.ts              # BullMQ worker setup
│   │   ├── processJob.ts         # Calls right adapter, handles errors
│   │   └── classifyError.ts      # Decides error_type from raw error
│   ├── adapters/
│   │   ├── types.ts              # SupermarketAdapter interface
│   │   ├── registry.ts           # Maps id -> adapter
│   │   ├── superx.ts
│   │   ├── supery.ts
│   │   └── ...one file per supermarket
│   ├── api/
│   │   ├── server.ts
│   │   ├── middleware/
│   │   │   ├── auth.ts           # API key validation
│   │   │   ├── pagination.ts
│   │   │   └── errorHandler.ts
│   │   └── routes/
│   │       ├── products.ts
│   │       ├── supermarkets.ts
│   │       ├── snapshots.ts
│   │       ├── alerts.ts
│   │       └── runs.ts
│   ├── alerts/
│   │   ├── classify.ts           # When to create what alert
│   │   ├── notify.ts             # Telegram bot sender
│   │   └── aggregate.ts          # Group product-level into supermarket-level
│   ├── shared/
│   │   ├── db.ts                 # Supabase client
│   │   ├── queue.ts              # BullMQ + Redis
│   │   ├── logger.ts             # pino instance
│   │   ├── sentry.ts             # Sentry init
│   │   └── env.ts                # zod-validated env vars
│   └── types/
│       └── index.ts
├── scripts/
│   ├── setup-ec2.sh              # Idempotent first-time server setup
│   ├── seed-db.ts                # Initial schema + seed data
│   └── add-supermarket.ts        # Helper to register a new SM
├── ecosystem.config.js           # PM2 config (3 processes)
├── Caddyfile                     # Reverse proxy + auto-HTTPS
├── tsconfig.json
├── package.json
├── .env.example
└── .gitignore
```

---

## 6. Failure handling

### Two layers of "fallback"

- **Within one attempt**: each adapter can implement its own internal tier strategy (try API → fall back to HTML, etc.). This is per-supermarket.
- **Across attempts**: the engine handles retries with delay, then gives up and creates an alert.

### Error classification

```ts
// src/worker/classifyError.ts
function classifyError(err: unknown): ErrorType {
  if (err.code === 'ETIMEDOUT')      return 'network_timeout';
  if (err.status === 404)            return 'product_not_found';
  if (err.status === 429)            return 'rate_limited';
  if (err.status >= 500)             return 'site_server_error';
  if (err.name === 'SelectorError')  return 'selector_failed';
  if (err.name === 'ParseError')     return 'parse_failed';
  return 'unknown';
}
```

### Retry policy per error type

```ts
const retryPolicy = {
  network_timeout:     { maxAttempts: 3, delayMs: 60_000 },     // 1 min
  rate_limited:        { maxAttempts: 3, delayMs: 1_800_000 },  // 30 min
  site_server_error:   { maxAttempts: 3, delayMs: 600_000 },    // 10 min
  selector_failed:     { maxAttempts: 1, delayMs: 0 },          // don't retry, alert
  product_not_found:   { maxAttempts: 1, delayMs: 0 },          // don't retry, alert
  parse_failed:        { maxAttempts: 2, delayMs: 60_000 },
  unknown:             { maxAttempts: 3, delayMs: 600_000 },
};
```

Smarter than blanket "2 retries 2hr apart" — different errors deserve different responses.

### Alert aggregation

After each scrape run finishes, the orchestrator runs:

```ts
for (const supermarket of supermarkets) {
  const failureRate = computeFailureRate(supermarket, run);
  if (failureRate > 0.8) {
    createAlert('critical', 'supermarket_degraded', supermarket);
    suppressIndividualProductAlerts(supermarket);  // collapse 80 alerts into 1
  } else if (failureRate > 0.3) {
    createAlert('warning', 'supermarket_unstable', supermarket);
  }
}
```

You never get spammed. You get **one** alert: "SuperZ is degraded, 97/100 failing, top 3 errors: ...".

### Telegram notifications

Critical alerts → Telegram bot message:

```
🔴 CRITICAL: SuperZ degraded
97/100 products failing
Top errors:
  • selector_failed (89)
  • 404 (8)
View details: https://api.yoursite.com/v1/alerts/abc-123
```

Setup is just two HTTP calls to Telegram's bot API. No SDK needed.

---

## 7. API design

```
Auth: X-API-Key header on every request (validated against api_keys.key_hash)

GET    /v1/products                     ?page=1&limit=50&category=&search=
GET    /v1/products/:id
GET    /v1/products/:id/history         ?from=&to=&supermarket=
GET    /v1/products/:id/compare         (latest price across all supermarkets)

GET    /v1/supermarkets                 list with health status
GET    /v1/supermarkets/:id
GET    /v1/supermarkets/:id/products

GET    /v1/snapshots                    ?from=&to=&supermarket=&product=

GET    /v1/runs                         scrape history
GET    /v1/runs/:id                     drill-down: per-supermarket, per-tier breakdown

GET    /v1/alerts                       ?status=open&severity=
PATCH  /v1/alerts/:id                   { status: "acknowledged" | "resolved" }

GET    /v1/health                       no auth needed, for uptime monitoring
```

- Consistent response envelope: `{ data, pagination, meta }`
- Consistent error envelope: `{ error: { code, message, details } }`
- All list endpoints support `?page=&limit=`
- Date filters where relevant: `?from=&to=`

---

## 8. Deployment

### EC2 first-time setup (one script, idempotent)

`scripts/setup-ec2.sh`:

- Install Node 20 (via nvm)
- Install pm2 globally
- Install Redis, enable persistence (`appendonly yes`), start as systemd service
- Install Caddy
- Install Playwright browser dependencies
- Clone repo, install deps, build
- Symlink `Caddyfile` to `/etc/caddy/Caddyfile`
- Start pm2 processes
- `pm2 startup` + `pm2 save` (survives reboot)

Run once after spinning up the EC2. Then never again.

### Continuous deployment

`.github/workflows/deploy.yml`:

```yaml
name: Deploy to EC2
on:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npm run build
      - run: npm test

  deploy:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.EC2_HOST }}
          username: ubuntu
          key: ${{ secrets.EC2_SSH_KEY }}
          script: |
            cd /home/ubuntu/app
            git pull origin main
            npm ci --omit=dev
            npm run build
            pm2 reload ecosystem.config.js
            pm2 save
```

`pm2 reload` does a graceful zero-downtime restart of the API. Worker/orchestrator do a quick restart (BullMQ recovers any in-flight jobs).

### Caddyfile

```
api.yourdomain.com {
  reverse_proxy localhost:3000
}
```

Caddy gets a Let's Encrypt cert automatically and renews it. That's the whole HTTPS config.

### PM2 ecosystem (3 processes always running)

```js
module.exports = {
  apps: [
    { name: 'api',          script: 'dist/api/server.js',          instances: 1 },
    { name: 'worker',       script: 'dist/worker/index.js',        instances: 1 },
    { name: 'orchestrator', script: 'dist/orchestrator/index.js',  instances: 1 },
  ],
};
```

---

## 9. Observability — "what failed and why"

Three layers, each with a specific purpose:

| Layer | Tool | What it shows |
|---|---|---|
| **System errors** (uncaught crashes) | Sentry | Stack traces, breadcrumbs, release tagging |
| **Scraping issues** (per-job) | DB tables (`job_executions`, `alerts`) | Every retry, every failure, every category |
| **Process logs** (raw output) | pino → PM2 → log file | Rolling logs on disk, last 7 days |

### Investigation flow when something feels off

1. Open dashboard (later) or hit `/v1/runs/latest`: today's stats
2. Drill into failures: `/v1/runs/:id` → breakdown by supermarket, by error type
3. For specific failure: query `job_executions` with full error stack
4. For uncaught crashes: Sentry has it
5. For weird intermittent stuff: PM2 logs (`pm2 logs worker --lines 1000`)

### Queue resilience

- Queue lives in Redis, **not** in Node process memory.
- `git push` → `pm2 reload` does **not** reset the queue.
- BullMQ recovers in-flight jobs after worker restart (~30s stall timeout).
- You can deploy fixes mid-scrape without losing data.

---

## 10. Build phases

### Phase 1 — Foundation (~3-4 days)

- [ ] TS project scaffold, tsconfig, eslint, prettier
- [ ] DB schema migration (Supabase migrations or raw SQL)
- [ ] Shared utilities: db client, logger, env validation, Sentry init
- [ ] BullMQ + Redis local connection working
- [ ] Adapter interface + registry
- [ ] First adapter: pick the **easiest** supermarket (one with a clean public API)
- [ ] End-to-end manual run: scrape → save → query DB

**Goal**: 1 supermarket scraping ~10 products, data in DB, no API yet.

### Phase 2 — Engine (~3-4 days) ✅

- [x] Orchestrator with cron + enqueue all jobs (`src/orchestrator/`)
- [x] Worker processing jobs through adapters (`src/worker/`)
- [x] Error classification + retry policy
- [x] Alert generation + aggregation (per-supermarket, no spam)
- [x] Telegram notifications (`src/alerts/notify.ts`)
- [x] PM2 ecosystem config (`ecosystem.config.cjs`)

**Goal**: Daily scrape runs automatically, failures recorded, you get a Telegram ping if SuperX is down.

End-to-end queue-level testing happens in Phase 5 on EC2 (Redis runs there). Telegram notifier and adapter are smoke-tested locally.

### Phase 3 — Add a second supermarket (~half day) ✅

- [x] Carrefour adapter (`src/adapters/carrefour.ts`) — VTEX-based, fetch only
- [x] `resolveExternalId` added to adapter contract; Coto refactored to use it
- [x] `scripts/scrape-url.ts` updated to delegate ID resolution to adapters
- [x] End-to-end smoke tested with real Carrefour product (productId=51090)
- [ ] Playwright-based supermarket (deferred — no current target requires it; VTEX covers ~half the LATAM list)

**Result**: 2 supermarkets working. Adapter pattern proven across two storefront types (Coto's bespoke JSON, VTEX standard catalog API). Most LATAM supermarkets (Disco, Jumbo, Vea, Día, La Anónima) are also VTEX, so `carrefour.ts` becomes a near-drop-in template.

### Phase 4 — API (~2-3 days) ✅

- [x] Express 5 server with auth middleware (`src/api/`)
- [x] All routes implemented (`products`, `supermarkets`, `snapshots`, `runs`, `alerts`, `health`)
- [x] Pagination, filtering, consistent envelope, CORS
- [x] X-API-Key auth (SHA-256 hash + 60s in-memory cache)
- [x] `scripts/create-api-key.ts` helper
- [ ] OpenAPI spec generation (optional, deferred until frontend exists)

**Goal**: Frontend (whenever it's built) can read everything via HTTPS + API key. Smoke tested end-to-end against the real Coto product in Supabase.

### Phase 5 — Deploy (~1-2 days) — IN PROGRESS

Artifacts written:

- [x] `scripts/setup-ec2.sh` — one-shot bootstrap (Node 22, PM2, Redis, Caddy, UFW)
- [x] `Caddyfile` — reverse proxy with automatic HTTPS via Let's Encrypt
- [x] `.github/workflows/deploy.yml` — push-to-main → typecheck → SSH → pm2 reload, with Telegram notifications on success/failure
- [x] `DEPLOY.md` — step-by-step Phase A–F guide (AWS setup, DNS, bootstrap, first deploy, GitHub Actions, troubleshooting)

User-driven steps (waiting on user):

- [ ] Provision EC2 instance + Elastic IP (DEPLOY.md Phase A)
- [ ] Point `api.megaanalytics.com` DNS A record at the Elastic IP (Phase B)
- [ ] Run `setup-ec2.sh` on the server (Phase C)
- [ ] First manual deploy: clone, `.env`, build, Caddyfile, `pm2 start` (Phase D)
- [ ] Smoke test the live API (Phase E)
- [ ] Add GitHub Actions secrets (`EC2_HOST`, `EC2_SSH_KEY`, `TELEGRAM_*`) and trigger first auto-deploy (Phase F)
- [ ] First real scheduled scrape on production (next day after deploy)

**Goal**: `git push main` → auto-deploys. System runs daily without you touching anything.

Decisions locked in:

- Domain: `api.megaanalytics.com` (subject to user confirming the domain is registered)
- Region: `sa-east-1` (São Paulo)
- Instance: `t3.medium` (4 GB RAM, headroom for future Playwright)
- Redis: same EC2 (bound to localhost, no auth needed)
- Telegram alerts for deploys: same chat as scraper alerts

### Phase 6 — Scale up (ongoing)

- Add adapters one at a time
- Monitor Telegram alerts
- Tune rate limits as you learn each site's behavior
- Add Tier 3 (AI scraping) **only if** real failure data justifies it

**Product-management features (implemented):** see `docs/PRODUCT_MANAGEMENT.md`.
- Per-mapping pause/resume + hard delete (`PATCH`/`DELETE /v1/supermarket-products/:id`).
  `is_active=false` skips the mapping in the daily enqueue.
- Runtime-editable catalog: `catalog_extra_eans` table (migration `007`) supplements
  the hardcoded `TAXONOMY_BY_EAN`; coverage/discovery read the union via
  `src/shared/catalog.ts`. CRUD at `/v1/catalog/eans`.
- Async EAN discovery: `POST /v1/data/discover` (scopes: one EAN across all searchable
  chains / all EANs at one chain / one EAN at one chain / weekly `sweep`) runs on the
  `discovery` BullMQ queue; poll `GET /v1/data/discover/:jobId`. Core in `src/discovery/`,
  worker in `src/worker/discoveryWorker.ts`.
- Weekly coverage sweep: `SWEEP_CRON` (default Sunday 02:00) enqueues a `sweep` job that
  re-searches only the MISSING (EAN × searchable chain) pairs — products that came back
  in stock — auto-ingests them (EAN-bound), and Telegram-summarizes what it added. Paused
  products are never resurrected.
- Coverage is now pause-aware (`paused` count + per-product `active`).
- EAN healing: `PATCH /v1/supermarket-products/:id { ean }` binds an EAN-less mapping to
  the canonical master (merging + enriching from the catalog; price history preserved via
  `src/ingest/bindEan.ts`). Worklist at `GET /v1/products/missing-ean`. Fixes blank
  general columns in the client_base export.

---

## 11. Open decisions

These need confirmation before Phase 5:

| # | Question | Default if unanswered |
|---|---|---|
| 1 | Domain name? Buy one or use EC2 IP for now? | Plain HTTP on EC2 IP, add domain later |
| 2 | AWS region? `sa-east-1` São Paulo or `us-east-1`? | `sa-east-1` (lowest latency to Argentine sites) |
| 3 | Schedule: daily at 6am Buenos Aires (UTC-3)? | 6am UTC-3 |
| 4 | Sentry account ready? | TODO placeholder, wire up later |
| 5 | Telegram bot created? | TODO placeholder, wire up later |
| 6 | Which supermarket to start with? Need a name + sample product URL. | TBD — pick easiest with public API |

---

## 12. Environment variables

Documented in `.env.example`:

```bash
# Runtime
NODE_ENV=production
PROCESS_TYPE=                    # "api" | "worker" | "orchestrator"

# Database
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=

# Redis
REDIS_URL=redis://localhost:6379

# API
API_PORT=3000

# Observability
SENTRY_DSN=
LOG_LEVEL=info

# Notifications
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

# Scraping
SCRAPE_CRON=0 6 * * *           # 6am every day (server timezone)
TZ=America/Argentina/Buenos_Aires
```

All loaded and validated by `src/shared/env.ts` using zod. Process exits at startup if anything required is missing.
