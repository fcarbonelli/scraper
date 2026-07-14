# [AGENTS.md](http://AGENTS.md)

Project guide for AI coding agents (and humans) working on this repo.

## Project: Multi-supermarket price scraper

A Node/TypeScript backend service that scrapes 100+ products across 30+ supermarkets daily, stores price history in Supabase, and exposes everything through a REST API. Deployed on EC2 with PM2 + Caddy. Frontend is built separately and consumes the API.

## Read these first

- `**plan.md**` — canonical design doc (architecture, full DB schema, all key decisions, phase plan). If anything in this file conflicts with `plan.md`, `plan.md` wins; update it.
- `**API.md**` — external-facing REST API reference (auth, endpoints, TypeScript types, response shapes, UI workflows). The source of truth for API consumers (frontend, partners). Keep it in sync when changing routes.
- `**examples/api/**` — JSON response fixtures matching the API envelope exactly. Used for frontend dev before deploy and as test data. Update any time a route's response shape changes.
- `**DEPLOY.md**` — step-by-step deployment guide (AWS setup, server bootstrap, first deploy, GitHub Actions, troubleshooting). Read when working on infra; keep in sync when changing the deploy flow.
- `**docs/ADDING_SUPERMARKETS.md**` — hands-on playbook for mapping a new supermarket: the VTEX factory, verification commands, the preview-vs-go-live distinction, and the gotchas (Cencosud WAF, `listPrice` sentinel). Read this before adding a store.
- `**docs/REVISTA_REVIEW.md**` — design + frontend contract for the **magazine (revista) review** path (IMPLEMENTED): AI reads promo PDFs/flipbooks for chains that don't publish prices on the web (Makro, Vital, Rosental, Maxicomodín), matches them against the catalog, and an operator approves/rejects in a modal inside the Daily Review screen. Backend lives in `src/revistas/` (orchestrator runs the daily check; `/v1/revistas/*` serves the review UI). Read before touching the revista pipeline.
- `**summary.md**` — original problem framing (read once for context, then ignore).

## Tech stack (locked in)

- **Language**: TypeScript strict mode, ES modules (`"type": "module"`, NodeNext)
- **Runtime**: Node 20+ (developed on Node 22)
- **Database**: Supabase (Postgres) via `@supabase/supabase-js`
- **Queue**: BullMQ on Redis (one queue per supermarket)
- **HTTP server**: Express 5
- **HTTP scraping**: native `fetch` for APIs, Playwright for browser scraping (Phase 3+)
- **Validation**: zod
- **Logging**: pino (structured JSON; pretty in dev)
- **Error tracking**: Sentry (optional, no-op without DSN)
- **Process manager**: PM2 (production)
- **Reverse proxy / HTTPS**: Caddy
- **CI/CD**: GitHub Actions → SSH → `pm2 reload`
- **Notifications**: Telegram bot

## Architecture: engine + adapters

The system is split into two layers. **Never mix them.**

```
ENGINE (built once, rarely touched)
  src/orchestrator/   cron, enqueues daily jobs
  src/worker/         pulls jobs, calls adapter, classifies errors, persists
  src/api/            HTTP server, routes, auth
  src/shared/         db, queue, logger, env, sentry, errors
  src/alerts/         alert generation + Telegram notifications

ADAPTERS (one file per supermarket)
  src/adapters/<id>.ts   the actual per-site scraping logic
```

The worker code is **site-agnostic**. It looks up `getAdapter(supermarketId)` and calls `adapter.scrape(ctx)`. Adding a new supermarket = writing one adapter file + one DB row, not changing the engine.

## Project structure

```
scraper/
├── AGENTS.md                          ← you are here
├── plan.md                            ← canonical design
├── API.md                             ← external API reference (for frontend/partners)
├── DEPLOY.md                          ← step-by-step EC2 deployment guide
├── summary.md                         ← original problem framing
├── package.json
├── tsconfig.json
├── ecosystem.config.cjs               ← PM2 process config (for EC2)
├── Caddyfile                          ← reverse proxy + HTTPS (lives at /etc/caddy/Caddyfile on the server)
├── .env / .env.example                ← .env is gitignored
├── .github/workflows/
│   └── deploy.yml                     ← push-to-main → typecheck → SSH → pm2 reload → Telegram notify
├── migrations/
│   └── 001_initial_schema.sql         ← run in Supabase SQL editor
├── scripts/
│   ├── test-adapter.ts                ← smoke test adapter, no DB needed
│   ├── test-telegram.ts               ← smoke test Telegram bot
│   ├── setup-db.ts                    ← seed supermarket rows
│   ├── scrape-url.ts                  ← full pipeline test for any URL
│   ├── import-urls.ts                 ← bulk-import URLs from a text file
│   ├── heal-eans.ts                   ← one-time backfill of catalog EANs onto EAN-less products
│   └── setup-ec2.sh                   ← one-shot bootstrap for a fresh Ubuntu EC2 (Phase 5)
└── src/
    ├── adapters/
    │   ├── types.ts                   ← SupermarketAdapter contract
    │   ├── registry.ts                ← maps id → adapter
    │   ├── coto.ts                    ← Coto Digital (JSON API; SKU in URL)
    │   ├── carrefour.ts               ← Carrefour (VTEX; slug→productId pagetype lookup)
    │   ├── maxi-carrefour.ts          ← Carrefour Maxi Pedido (custom PHP; HTML fragment, gated prices)
    │   ├── maxi-carrefour-auth.ts     ← Playwright self-healing PHPSESSID for Maxi Carrefour
    │   ├── maxiconsumo.ts             ← Maxiconsumo (Magento 2; HTML microdata + dataLayer)
    │   ├── atomo.ts                   ← Átomo Conviene (PrestaShop; HTML JSON-LD)
    │   └── lacoopeencasa.ts           ← La Coope en Casa / Cooperativa Obrera (Be2 JSON API)
    ├── shared/
    │   ├── env.ts                     ← zod-validated env vars
    │   ├── logger.ts                  ← pino instance
    │   ├── db.ts                      ← Supabase client
    │   ├── queue.ts                   ← BullMQ + Redis
    │   ├── sentry.ts                  ← error tracking
    │   └── errors.ts                  ← ScrapeError + ErrorType
    ├── alerts/
    │   ├── notify.ts                  ← Telegram bot sender
    │   ├── createAlert.ts             ← DB insert + optional Telegram
    │   └── aggregate.ts               ← per-supermarket aggregation
    ├── ingest/
    │   ├── index.ts                   ← detect supermarket + ensure rows + optional first scrape (used by scripts AND POST /v1/products); accepts a forced `ean`
    │   └── bindEan.ts                 ← bind an EAN-less mapping to the canonical master (merge + enrich; heals blank export columns)
    ├── discovery/                     ← reusable EAN-discovery core + missing-EAN sweep helpers + eanMatch.ts (heal suggestions) + eanJudge.ts (LLM adjudication) (see docs/PRODUCT_MANAGEMENT.md)
    │   └── index.ts                   ← discoverEanAtSupermarket / EanEverywhere / AllEansAtSupermarket (used by CLI + discovery worker)
    ├── revistas/                      ← magazine (revista) pipeline — see docs/REVISTA_REVIEW.md
    │   ├── sources.ts                 ← cheap discovery (dedup hash) + lazy download per strategy
    │   ├── render.ts / image.ts       ← PDF→PNG (pdf-to-img) + image magic-byte sniffing
    │   ├── extract.ts                 ← GPT-4 Vision page→products (structured outputs)
    │   ├── match.ts                   ← EAN → embeddings → brand filter → LLM judge
    │   ├── catalog.ts / storage.ts    ← load master catalog from DB / upload page images to Storage
    │   ├── store.ts                   ← revista_magazines + revista_review_items persistence
    │   ├── approve.ts                 ← approve/manual-add → supermarket_products + price_snapshots
    │   └── pipeline.ts                ← runRevistaCheck(): the daily entry point (called by orchestrator)
    ├── orchestrator/
    │   ├── index.ts                   ← cron + finalizer interval
    │   ├── enqueue.ts                 ← create scrape_run, enqueue jobs
    │   └── finalize.ts                ← detect completion, generate alerts
    ├── worker/
    │   ├── index.ts                   ← bootstraps a Worker per supermarket + one discovery worker
    │   ├── discoveryWorker.ts         ← consumes the `discovery` queue → src/discovery core
    │   ├── processJob.ts              ← pure orchestrator (queue-agnostic)
    │   ├── classifyError.ts           ← raw error → ErrorType
    │   ├── retryPolicy.ts             ← per-error retry rules
    │   └── persist.ts                 ← DB writes for job lifecycle
    └── api/
        ├── server.ts                  ← entry point: bind & listen
        ├── app.ts                     ← buildApp() — Express factory
        ├── types.ts                   ← request augmentation (apiKey, pagination)
        ├── lib/
        │   ├── apiError.ts            ← ApiError + status codes
        │   ├── envelope.ts            ← success/paginated/failure builders
        │   └── parseQuery.ts          ← zod query/body parsing
        ├── middleware/
        │   ├── auth.ts                ← X-API-Key validation (SHA-256 + cache)
        │   ├── pagination.ts          ← parse page/limit, attach to req
        │   ├── errorHandler.ts        ← turn errors into envelope responses
        │   └── requestLogger.ts       ← per-request structured logs
        └── routes/
            ├── health.ts              ← GET /v1/health (public)
            ├── products.ts            ← list, detail, compare, history, POST (add URL; optional `ean` binding), DELETE master
            ├── supermarkets.ts        ← list, detail, products (?status=active|paused|all)
            ├── supermarketProducts.ts ← PATCH pause/resume + DELETE one mapping + PATCH lifecycle
            ├── catalog.ts             ← /v1/catalog/eans CRUD (runtime EAN additions)
            ├── data.ts                ← pricing/export/coverage + /discover (async EAN discovery)
            ├── snapshots.ts           ← raw feed with filters
            ├── runs.ts                ← list, detail with breakdown
            └── alerts.ts              ← list, PATCH (ack/resolve)
```

## Commands cheat sheet


| Command                           | What it does                                          | When to use                                            |
| --------------------------------- | ----------------------------------------------------- | ------------------------------------------------------ |
| `npm run db:setup`                | Inserts/updates supermarket rows                      | Runs automatically on deploy (idempotent). Manual only for one-offs against a fresh DB. |
| `npm run test:adapter`            | Hits adapter directly (no DB)                         | Debug parsing changes fast                             |
| `npm run test:telegram`           | Sends one of each severity to your bot                | Verify Telegram setup                                  |
| `npm run scrape:url -- <url>`     | Full pipeline test for a single URL (bypasses queue)  | Verify a supermarket works end-to-end without Redis    |
| `npm run scrape:bulk -- <file>`   | Bulk-import URLs from a text file (one per line)      | Add many products at once; idempotent, safe to re-run  |
| `npx tsx --env-file=.env scripts/heal-eans.ts [--judge] [--auto] [--apply=<csv>]` | Backfill catalog EANs onto EAN-less products (fixes blank export columns); `--judge` adds an LLM adjudication pass | One-time backlog cleanup: report → (judge) → confirm CSV → apply. NB: use `npx tsx` directly — PowerShell drops `--` in `npm run … -- <flags>` |
| `npm run revistas:run -- [--super=<id>] [--pages=1-8] [--force]` | Run the magazine (revista) pipeline manually | Test/backfill a magazine chain; needs `OPENAI_API_KEY` |
| `npm run revistas:doctor` | Diagnose the revista pipeline (config, live discovery, DB state, catalog stats) — **no AI cost** | First stop when "no magazines show up in the frontend" |
| `npm run revistas:run -- --carry-forward` | Re-emit today's magazine prices (latest approved price → fresh snapshot dated today) — no AI, no scraping | Backfill today's export; the orchestrator does this daily automatically |
| `npm run orchestrator:run-now`    | Run a one-shot daily scrape immediately (needs Redis) | Manual trigger, e.g., backfill                         |
| `npm run apikey:create -- <name>` | Generate an API key, store hash, print plaintext once | Granting access to a new consumer (frontend, etc.)     |
| `npm run typecheck`               | `tsc --noEmit`                                        | Always run before suggesting code is "done"            |
| `npm run lint`                    | ESLint over `**/*.ts`                                 | Before committing                                      |
| `npm run dev:worker`              | BullMQ worker with hot reload (needs Redis)           | Local dev                                              |
| `npm run dev:orchestrator`        | Cron process locally (needs Redis)                    | Local dev                                              |
| `npm run dev:api`                 | Express API locally                                   | Local dev for the API                                  |
| `npm run build`                   | Compile TS → `dist/src/`                              | Before deploy                                          |
| `pm2 start ecosystem.config.cjs`  | Start orchestrator + worker + api (production / EC2)  | After `npm run build`                                  |


All scripts that need env vars use `--env-file=.env` (Node ≥20.6 native flag).

## Conventions

### TypeScript

- **Strict mode is ON** (`noUncheckedIndexedAccess`, `noImplicitOverride`, etc.). Don't loosen `tsconfig.json` to silence type errors — fix the code.
- **Imports use `.js` extensions** even when importing `.ts` files (required by NodeNext). Example:
  ```ts
  import { db } from '../shared/db.js';   // ✅ even though file is db.ts
  import { db } from '../shared/db';       // ❌ won't compile
  ```
- **No comments narrating obvious code** (`// import the module`, `// loop through items`). Comments should explain *why* and non-obvious intent only.
- **Use `unknown` over `any`** and narrow with type guards or zod.

### Error handling

- **Adapters throw `ScrapeError`** from `src/shared/errors.ts` with the right `ErrorType`. The retry policy keys off this. Example:
  ```ts
  if (res.status === 429) {
    throw new ScrapeError('rate_limited', `429 from ${url}`, { httpStatus: 429 });
  }
  ```
- **Don't swallow errors.** Either let them propagate or transform them into `ScrapeError`s with context.
- **Don't return null/undefined for "failed" scrapes.** The adapter must succeed (return `ScrapeResult`) or throw.

### Logging

- **Use `logger.child({ ... })` for context.** Inside the worker the context (supermarket, sku, attempt) is already attached — keep adding more if useful:
  ```ts
  const log = ctx.logger.child({ url: jsonUrl });
  log.debug('fetching');
  ```
- **No `console.log` in `src/`.** Acceptable in `scripts/` for one-off CLI output.
- **Don't log secrets.** The logger has a redact list — extend it if you add new secret-looking fields.

### Database access

- **Always import `db` from `src/shared/db.ts`.** Never `createClient(...)` elsewhere.
- **Service-role key bypasses RLS** — that's intentional (server-side only). Don't enable RLS expecting it to protect server code.
- **Time-sensitive reads/writes go through `src/worker/persist.ts`.** Don't sprinkle DB calls across the worker logic.

### API design

- **Always go through `src/api/lib/envelope.ts`.** Routes return `success(data)` or `paginated(items, total, page, limit)`. Errors are `failure(code, message, details)` — but you should `throw new ApiError(...)` and let the error handler format it.
- **Auth is enforced by `requireApiKey` middleware**, mounted at `/v1` in `app.ts`. Public routes (`/v1/health`) are mounted before it.
- **Validate every query/body with zod** via `parseQuery(req, Schema)` / `parseBody(req, Schema)`. Don't trust `req.query` shape directly.
- **API keys are hashed with SHA-256** (not bcrypt) — the keys we generate already have 256 bits of entropy, so a slow KDF buys nothing. Plaintext is shown once on creation and never recoverable.
- **Don't add new routes outside `src/api/routes/`** and don't bypass the centralized middleware order in `app.ts`.
- **When you change a route's shape or add an endpoint, update `API.md` AND the matching `examples/api/*.json` fixture in the same change.** External consumers depend on both.

### Module patterns

- One default export per file = avoid. Prefer named exports for refactor friendliness.
- Pure logic should be importable without side effects (env, db). Side-effecting modules (`db.ts`, `sentry.ts`) document this in their header.

## How to add a new supermarket

> For the full hands-on version (exact commands, VTEX factory template, preview-vs-go-live, gotchas) see `**docs/ADDING_SUPERMARKETS.md**`. The summary below is the quick reference.

1. **Write the adapter** at `src/adapters/<id>.ts` implementing the `SupermarketAdapter` interface.
  - **VTEX stores (most of the list)**: don't copy `carrefour.ts`. Use the factory `createVtexAdapter({ id, name, host })` from `src/adapters/vtex.ts` — your adapter is ~10 lines (see `vea.ts`/`jumbo.ts`/`disco.ts`).
  - References (pick the closest one to the new site's stack):
    - `src/adapters/coto.ts` — single JSON API endpoint, id embedded in URL
    - `src/adapters/lacoopeencasa.ts` — JSON API behind an Angular SPA; envelope-style `{ estado, mensaje, datos }`
    - `src/adapters/carrefour.ts` — VTEX storefront, two-call ingestion (slug → productId pagetype, then catalog)
    - `src/adapters/atomo.ts` — PrestaShop SSR HTML, parses `<script type="application/ld+json">`
    - `src/adapters/maxiconsumo.ts` — Magento 2 SSR HTML, parses microdata (`itemprop=`) + inline GA4 `dataLayer`
    - `src/adapters/maxi-carrefour.ts` — custom PHP backend returning HTML fragments, prices gated behind a session cookie
  - Always implement `canonicalizeUrl` — strip ALL query/hash params and lowercase the host. Sites often pass tracking params in URLs (e.g. Coto's `?Dy=1&assemblerContentCollection=...`) that break the JSON endpoint if left intact.
  - Implement `resolveExternalId(url)` if the external_id can't be derived from URL alone (e.g. needs a network lookup). Steady-state daily scrapes never call this — it runs once when a URL is first ingested.
  - Throw `ScrapeError` with the right type for known failure modes (`auth_required`, `product_not_found`, `price_missing`, `selector_failed`, ...).
  - Extract everything you can into `productInfo` and `rawData`.
2. **Register it** in `src/adapters/registry.ts` (one line).
3. **Seed metadata** by adding the supermarket to `SUPERMARKETS` in `scripts/setup-db.ts` (id, name, base_url, rate_limit_ms, concurrency). The CI/CD pipeline runs `npm run db:setup` automatically on every deploy (idempotent upsert), so just pushing to main inserts the row in production. No manual SSH step needed.
4. **Add URL detection** in `src/ingest/index.ts` (the `detectSupermarket` function — match by hostname; order matters when one host is a subdomain of another). Both `scrape:url` and `scrape:bulk` will pick it up automatically.
5. **Smoke test (no DB needed)**: `npm run test:adapter -- <a-product-url>`. The script auto-detects the supermarket, runs canonicalize → resolve external_id → scrape, and prints the `ScrapeResult`.
6. **End-to-end test**: `npm run scrape:url -- <a-product-url>`. Run it twice — the second run should skip the "adapter probe" line, confirming the cached external_id is being used. **Verify** the DB has rows in `supermarket_products` and `price_snapshots`.
7. **Push to main**. CI typechecks, deploys to EC2, runs `db:setup`, then `pm2 reload`. The worker also **auto-reconciles active supermarkets every ~60s** (`RELOAD_INTERVAL_MS` in `src/worker/index.ts`), so even activating a chain WITHOUT a redeploy (just `db:setup`) is picked up within a minute — no manual `pm2 reload worker` needed. End-to-end: just push.

### Per-supermarket auth (cookies, tokens)

Some sites gate prices behind a logged-in session (Carrefour Maxi Pedido is the canonical example: `data-price="private"` until you authenticate). For these adapters:

- Read the secret from **`SupermarketConfig.config.<key>`** first (DB-driven; refresh without redeploy by updating `supermarkets.config` JSON).
- Fall back to a typed env var in `src/shared/env.ts` for one-off operator runs (e.g. `MAXI_CARREFOUR_PHPSESSID`).
- Throw `ScrapeError('auth_required', ...)` with a clear message when the session is missing or expired so an alert fires and the operator knows to refresh it.

#### Self-healing auth via Playwright (Maxi Carrefour pattern)

When the login form is reCAPTCHA-Enterprise-protected (so plain `fetch` can't pass it) we drive a real Chromium via Playwright to harvest a fresh cookie automatically. The flow lives in `src/adapters/maxi-carrefour-auth.ts` and is **purely event-driven — no cron**:

1. `scrape()` tries the request with whatever cookie is in DB / env.
2. If the response says "private" (auth required), it calls `refreshCookie()`.
3. `refreshCookie()` is a process-level singleton: concurrent scrapes detecting expiry simultaneously share one Playwright run.
4. The new cookie is written to `supermarkets.config.phpSessId` so the next run (and sibling workers) pick it up.
5. `scrape()` retries once. Still private? → `auth_required` (login flow itself is broken or this product isn't carried by the picked sucursal).

Bootstrap / debug: `npm run maxi-carrefour:login` runs the Playwright flow standalone, prints the cookie, and persists it (or `--dry-run` to skip the DB write). Useful flags:

- `--headed` — open a visible Chrome window (great for diagnosing reCAPTCHA blocks).
- `--no-chrome` — fall back to bundled Playwright Chromium when system Chrome isn't installed.
- `--region=<value> --seller=<id>` — pin a specific sucursal. Use this if the default "first available seller" doesn't carry your products.

**Seller / sucursal binding**: every PHPSESSID is bound to one sucursal, and not every sucursal carries every product (e.g. seller 217 / BS AS NORTE doesn't stock the Coto-canonical lavandina). When a freshly-harvested cookie still returns `data-price="private"`, the most common cause is sucursal mismatch — fix by re-running with `--region=…` `--seller=…` once to find a sucursal with the broadest catalog for your URLs, then pin it via `supermarkets.config.maxiCarrefourLogin = { pick: { region, seller }, ... }` so all future auto-refreshes use it.

Other knobs in `supermarkets.config.maxiCarrefourLogin`:

- `name`, `email`, `phone`, `numberId` — throwaway form values (any plausible-looking values work; nothing is verified server-side beyond shape).
- `headless` — set `false` if running where Google's reCAPTCHA Enterprise rejects headless Chrome.
- `useSystemChrome` — defaults to `true` (real Chrome scores higher with reCAPTCHA than `chromium-headless-shell`).

### Note on VTEX-based supermarkets

Many LATAM supermarkets run on VTEX (Carrefour, Disco, Jumbo, Vea, Día, etc.). For any of them, use the shared factory **`createVtexAdapter({ id, name, host })`** in `src/adapters/vtex.ts` — a new VTEX store is a ~10-line file (`vea.ts`/`jumbo.ts`/`disco.ts`), not a copy of `carrefour.ts`. The factory handles the `pagetype` slug→productId lookup, the regionalized `catalog_system/pub/products/search` scrape with geo-fallback, promotions, `searchByEan`, a browser User-Agent (Cencosud's WAF 429s bot UAs), and a `listPrice` sanity guard (Cencosud emits garbage sentinels). The legacy `carrefour.ts` predates the factory and keeps its own identical implementation (untouched on purpose); new stores always use the factory. Always verify the endpoints respond for the new domain before assuming.

**NB:** Carrefour's wholesale portal `comerciante.carrefour.com.ar` (Maxi Pedido) is a custom PHP app, NOT VTEX — see `maxi-carrefour.ts`. La Anónima (`laanonima.com.ar`, `/art_<id>/` URLs) is also NOT VTEX.

## How to add products in bulk

Put the URLs into a plain text file (one per line, blank lines and `#` comments allowed), then:

```bash
npm run scrape:bulk -- path/to/urls.txt
```

What it does for each URL:

1. Detects the supermarket from the hostname.
2. Resolves the external_id via the adapter (URL parse for Coto, `pagetype` API call for Carrefour).
3. Creates `products` + `supermarket_products` rows. If a master product with the same EAN already exists (e.g. you imported the same item from another supermarket), the new row reuses it.
4. Runs the first price scrape so you immediately get a snapshot.

Re-run the same file safely — already-imported URLs are detected and skipped. Use `--rescrape` if you want to force a fresh snapshot for everything in the file.

The script exits non-zero if any URL failed, so the final summary log + `failures` array tell you exactly which URLs need fixing (usually a typo'd URL or a product that no longer exists on the supermarket site).

## Debugging: where to look when something fails

In order:

1. `**job_executions` table** in Supabase
  ```sql
   SELECT supermarket_product_id, status, error_type, error_message, started_at
   FROM job_executions
   ORDER BY started_at DESC LIMIT 20;
  ```
   Tells you what failed and the error category.
2. `**alerts` table** for aggregated issues:
  ```sql
   SELECT * FROM alerts WHERE status='open' ORDER BY created_at DESC;
  ```
3. **Sentry** (if `SENTRY_DSN` is configured) for unhandled exceptions with stack traces.
4. **PM2 logs** in production: `pm2 logs worker --lines 1000`.
5. **Re-run a single URL locally**:
  ```bash
   npm run scrape:url -- "<problem-url>"
  ```
   The terminal output will show the full error including stack.

## What NOT to do

- ❌ Don't put scraping logic in `src/worker/`. Adapters own scraping; the worker only orchestrates.
- ❌ Don't bypass `processJob` and write to `price_snapshots` directly. Snapshots and `job_executions` rows must always be written together.
- ❌ Don't run BullMQ jobs without a stored `attempt` number — retry policy depends on it.
- ❌ Don't change the DB schema without updating `plan.md` and writing a new numbered migration in `migrations/`. Never edit existing migrations.
- ❌ Don't commit `.env`, `*.pem`, or anything in `secrets/`. `.gitignore` covers `.env*` already.
- ❌ Don't disable or relax the env validation in `src/shared/env.ts` to "fix" startup errors. Fix the missing env var instead.
- ❌ Don't introduce a new top-level dependency without a clear reason. The stack is locked.

## Phase status

Track the build phases (see `plan.md` for full breakdown):

- **Phase 1** — Foundation: scaffold, schema, shared utils, adapter contract, Coto adapter, worker (built but not yet wired to Redis), end-to-end test working
- **Phase 2** — Engine: orchestrator (cron + enqueue), BullMQ worker wired, alert generation/aggregation, Telegram notifications, PM2 ecosystem config. Untested at the queue level — proven in Phase 5.
- **Phase 3** — Add a Playwright-based supermarket (deferred until next supermarket chosen)
- **Phase 4** — Express API: all routes (`products`, `supermarkets`, `snapshots`, `runs`, `alerts`, `health`), X-API-Key auth (SHA-256 + cache), pagination, error envelope, CORS, request logging. End-to-end smoke tested. Carrefour adapter added (VTEX-based), Coto adapter refactored to expose `resolveExternalId`.
- [~] **Phase 5** — Deploy: artifacts written (`scripts/setup-ec2.sh`, `Caddyfile`, `.github/workflows/deploy.yml`, `DEPLOY.md`). User performs AWS setup; first deploy & GitHub Actions wiring still pending.
- **Phase 6** — Scale: more supermarkets, monitoring tuning. **Product management** (see `docs/PRODUCT_MANAGEMENT.md`): per-mapping pause/delete, runtime-editable catalog (`catalog_extra_eans`, migration 007), async EAN discovery (`/v1/data/discover` on the `discovery` queue), pause-aware coverage, weekly coverage **sweep** (`SWEEP_CRON`, re-searches missing EANs + Telegram summary), and **EAN healing** (`PATCH /v1/supermarket-products/:id { ean }` + `GET /v1/products/missing-ean` → `src/ingest/bindEan.ts`) to fix blank export columns.

When completing a phase, mark it done here AND in `plan.md` (section 10).