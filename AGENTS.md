# [AGENTS.md](http://AGENTS.md)

Project guide for AI coding agents (and humans) working on this repo.

## Project: Multi-supermarket price scraper

A Node/TypeScript backend service that scrapes 100+ products across 30+ supermarkets daily, stores price history in Supabase, and exposes everything through a REST API. Deployed on EC2 with PM2 + Caddy. Frontend is built separately and consumes the API.

## Read these first

- `**plan.md**` — canonical design doc (architecture, full DB schema, all key decisions, phase plan). If anything in this file conflicts with `plan.md`, `plan.md` wins; update it.
- `**API.md**` — external-facing REST API reference (auth, endpoints, TypeScript types, response shapes, UI workflows). The source of truth for API consumers (frontend, partners). Keep it in sync when changing routes.
- `**examples/api/**` — JSON response fixtures matching the API envelope exactly. Used for frontend dev before deploy and as test data. Update any time a route's response shape changes.
- `**DEPLOY.md**` — step-by-step deployment guide (AWS setup, server bootstrap, first deploy, GitHub Actions, troubleshooting). Read when working on infra; keep in sync when changing the deploy flow.
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
│   ├── lib/ingest.ts                  ← shared ingest logic used by the two scripts above
│   └── setup-ec2.sh                   ← one-shot bootstrap for a fresh Ubuntu EC2 (Phase 5)
└── src/
    ├── adapters/
    │   ├── types.ts                   ← SupermarketAdapter contract
    │   ├── registry.ts                ← maps id → adapter
    │   ├── coto.ts                    ← Coto Digital adapter (reference, JSON API)
    │   └── carrefour.ts               ← Carrefour adapter (reference, VTEX API)
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
    ├── orchestrator/
    │   ├── index.ts                   ← cron + finalizer interval
    │   ├── enqueue.ts                 ← create scrape_run, enqueue jobs
    │   └── finalize.ts                ← detect completion, generate alerts
    ├── worker/
    │   ├── index.ts                   ← bootstraps a Worker per supermarket
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
            ├── products.ts            ← list, detail, compare, history
            ├── supermarkets.ts        ← list, detail, products
            ├── snapshots.ts           ← raw feed with filters
            ├── runs.ts                ← list, detail with breakdown
            └── alerts.ts              ← list, PATCH (ack/resolve)
```

## Commands cheat sheet


| Command                           | What it does                                          | When to use                                            |
| --------------------------------- | ----------------------------------------------------- | ------------------------------------------------------ |
| `npm run db:setup`                | Inserts/updates supermarket rows                      | Once after migration; again after adding a supermarket |
| `npm run test:adapter`            | Hits adapter directly (no DB)                         | Debug parsing changes fast                             |
| `npm run test:telegram`           | Sends one of each severity to your bot                | Verify Telegram setup                                  |
| `npm run scrape:url -- <url>`     | Full pipeline test for a single URL (bypasses queue)  | Verify a supermarket works end-to-end without Redis    |
| `npm run scrape:bulk -- <file>`   | Bulk-import URLs from a text file (one per line)      | Add many products at once; idempotent, safe to re-run  |
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

1. **Write the adapter** at `src/adapters/<id>.ts` implementing the `SupermarketAdapter` interface.
  - References:
    - `src/adapters/coto.ts` — single JSON API endpoint, id embedded in URL
    - `src/adapters/carrefour.ts` — VTEX storefront, two-call ingestion (slug→id, then catalog)
  - Always implement `canonicalizeUrl` if the site has scraping-only URL params.
  - Implement `resolveExternalId(url)` if the external_id can't be derived from URL alone (e.g. needs a network lookup). Steady-state daily scrapes never call this — it runs once when a URL is first ingested.
  - Throw `ScrapeError` with the right type for known failure modes.
  - Extract everything you can into `productInfo` and `rawData`.
2. **Register it** in `src/adapters/registry.ts` (one line).
3. **Seed the supermarket row** by adding it to `SUPERMARKETS` in `scripts/setup-db.ts` then running `npm run db:setup`.
4. **Add URL detection** in `scripts/lib/ingest.ts` (the `detectSupermarket` function — match by hostname). Both `scrape:url` and `scrape:bulk` will pick it up automatically.
5. **Smoke test**: `npm run scrape:url -- <a-product-url>`. Run it twice — the second run should skip the "adapter probe" line, confirming the cached external_id is being used.
6. **Verify** the DB has rows in `supermarket_products` and `price_snapshots`.

### Note on VTEX-based supermarkets

Many LATAM supermarkets run on VTEX (Carrefour, Disco, Jumbo, Vea, Día, La Anónima, etc.). For any of them, the `carrefour.ts` adapter is a near-drop-in template — usually only the host constant and rate limit need to change. Always verify the `pagetype` and `catalog_system/pub/products/search` endpoints respond as expected for the new domain before assuming.

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
- **Phase 6** — Scale: more supermarkets, monitoring tuning

When completing a phase, mark it done here AND in `plan.md` (section 10).