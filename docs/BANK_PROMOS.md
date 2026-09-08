# Bank & Card Promotions — Design Doc

Design for a **new, isolated module** that scrapes **bank / credit-card
promotions** (Naranja X first, more providers later), stores them with weekly
history, and serves a **separate dashboard** through a dedicated API path.

> **Status: IMPLEMENTED — 8 providers: Naranja X + MODO + BBVA + Galicia + Macro + Santander + ICBC + Cuenta DNI.** The module is built and typechecks.
> It mirrors the structure of [`REVISTA_REVIEW.md`](./REVISTA_REVIEW.md) and
> [`IN_STORE_PRICE_ENTRY.md`](./IN_STORE_PRICE_ENTRY.md): a self-contained
> pipeline with its own tables, its own orchestrator entry, and its own
> `/v1/*` routes — **completely separate from the supermarket price engine**.
>
> **`modo` is the second provider and the big one:** MODO's public hub API
> (`modo.com.ar/promos`) aggregates **~26,000 promotions across 82 banks/wallets**
> into one feed — so it covers every bank on the wishlist (Galicia, Macro, BBVA,
> Santander, BNA, Provincia, ICBC, …) in a single adapter. Each promo is
> attributed to its bank via a new **`issuer`** column (migration `031`).
>
> **`bbva` is the third provider:** BBVA's benefits catalog
> (`bbva.com.ar/beneficios`) is backed by the public **Go** JSON API
> (`go.bbva.com.ar/willgo/fgo/API`) — no auth, ~900 card promos across 46 pages,
> issuer='BBVA' (migration `032`). It adds BBVA card-only promos (installments,
> Visa/Master) that overlap but extend MODO's QR feed.
>
> **`galicia`, `macro`, `santander` are providers #4–6 — the F5-WAF'd trio.**
> All three publish public JSON promo catalogs but sit behind an **F5 BIG-IP WAF
> that fingerprints the TLS handshake (JA3)**, so a plain server-side `fetch` is
> rejected. Their adapters use a shared **browser-fetch helper**
> (`src/promos/browserFetch.ts`): a real Chromium loads the bank's SPA and the API
> is called **in-page** (real Chrome JA3 + correct CORS). issuer='Banco Galicia' /
> 'Banco Macro' / 'Banco Santander' (migration `033`).
>
> **`icbc` + `cuentadni` are providers #7–8.** **ICBC** (migration `034`) has a
> public rubro-paginated JSON API (`prod-utilidades-icbc.pisol.net/api/web/v1`)
> whose calls carry an `apikey` + `accesstoken` the SPA injects, so its adapter
> captures both in-page via `browserFetch` — **337 merchant-level promos**,
> issuer='ICBC'. **Cuenta DNI** (Banco Provincia, migration `035`) — the only
> wishlist issuer **not** on MODO — turned out to have a **plain-fetch ASP.NET
> JSON API** (no WAF, no Playwright): the adapter discovers active rubro ids from
> the page (`filtrarPorRubro(<id>)`), fetches each, and keeps only current rows
> — **~25 category-level wallet promos**, issuer='Cuenta DNI'. To build the
> dashboard, read [`DASHBOARD_GUIDE.md`](./DASHBOARD_GUIDE.md). Remaining
> low-value candidates (BNA+, Mercado Pago) — see
> [`BANK_PROMOS_ROADMAP.md`](./BANK_PROMOS_ROADMAP.md).
>
> **What shipped differs from the original design in two good ways** (see
> [§ Implementation notes](#implementation-notes--what-actually-shipped) — the
> authoritative section; the proposed §§2–7 below are kept for history):
> 1. **No token / no Playwright needed.** The `binder/*` endpoints are plain
>    **public `POST`** calls (the earlier `403` was just wrong HTTP method).
>    The provider is a direct `fetch` — no Auth0, no headless browser.
> 2. **Binder-level model.** Each stored promotion is a *commerce card* that
>    bundles its individual promo **plans** (kept losslessly as `jsonb`), which
>    matches how the source actually groups them.
>
> **One manual step is yours:** apply the promos migrations to the `scraper`
> Supabase project (SQL editor), in order:
> `029_promos.sql` → `030_promotions_content_hash.sql` →
> `031_promos_issuer_and_modo.sql` (adds the `issuer` column + registers MODO) →
> `032_promos_bbva.sql` (registers BBVA) →
> `033_promos_galicia_macro_santander.sql` (registers the F5-WAF'd trio) →
> `034_promos_icbc.sql` (registers ICBC) →
> `035_promos_cuentadni.sql` (registers Cuenta DNI).
> The `promos-dashboard` API key has already been created and scoped to `promos`.

---

<a id="implementation-notes--what-actually-shipped"></a>
## Implementation notes — what actually shipped

### Files
```
src/promos/
  types.ts        ← PromoProvider contract + NormalizedPromotion / PromotionPlan
  config.ts       ← env-derived settings (enabled, cron, timeouts)
  normalize.ts    ← pure helpers: weekday maps (ids + letters), AR date parse, %/cuotas parse, card-network + purchase-flow maps (unit-testable)
  naranjax.ts     ← provider #1: /data-for-filter + paged POST /binder/filter → normalized
  modo.ts         ← provider #2 (the hub): GET /slots?source=hub (paged) → normalized, issuer per card
  bbva.ts         ← provider #3: GET /v3/communications?pager=N (paged) → normalized, issuer='BBVA'
  browserFetch.ts ← shared Playwright helper: launch Chromium → navigate SPA origin → fetch API in-page (clears F5/JA3 WAFs + CORS); optional captureHeaders for public tokens
  galicia.ts      ← provider #4: in-page GET /personalizacion/v1/promociones/catalogo?page=N → normalized, issuer='Banco Galicia'
  macro.ts        ← provider #5: in-page GET /v1/card-benefits/provinces/{code} (per-province, deduped) w/ captured apikey → normalized, issuer='Banco Macro'
  santander.ts    ← provider #6: in-page /bff-benefits/brands + /brands/{id} (list→detail) → normalized, issuer='Banco Santander'
  icbc.ts         ← provider #7: in-page /beneficios/get?heading_id=<rubro>&offset=N (per-rubro) w/ captured apikey+accesstoken → normalized, issuer='ICBC'
  cuentadni.ts    ← provider #8 (plain fetch, no Playwright): discover rubros from page → GET /Home/GetBeneficioByRubro?idRubro=<id>, keep current → normalized, issuer='Cuenta DNI'
  registry.ts     ← id → provider (naranjax, modo, bbva, galicia, macro, santander, icbc, cuentadni)
  store.ts        ← upsert promotions (incl. issuer) + weekly snapshot + deactivate-missing
  pipeline.ts     ← runPromoCheck(): weekly entry point (called by orchestrator)
src/api/routes/promos.ts   ← GET /v1/promos, /:id, /providers, /filters (+ promos-scope guard)
migrations/029_promos.sql  ← promo_providers, promotions, promotion_snapshots (+ naranjax seed)
migrations/030_…hash.sql   ← content_hash (snapshot dedup)
migrations/031_…issuer_and_modo.sql ← issuer column + MODO provider seed
migrations/032_promos_bbva.sql      ← BBVA provider seed
migrations/033_promos_galicia_macro_santander.sql ← Galicia/Macro/Santander seeds (Playwright providers)
migrations/034_promos_icbc.sql      ← ICBC provider seed (Playwright)
migrations/035_promos_cuentadni.sql ← Cuenta DNI provider seed (plain fetch)
scripts/promos-run.ts      ← npm run promos:run
scripts/promos-doctor.ts   ← npm run promos:doctor (reachability, no writes)
```

### How MODO is fetched (verified, all public `GET`)

MODO's promos hub is a Next.js SPA backed by a **public JSON BFF proxied on the
site's own origin** — no auth, browser headers only. Base:
`https://www.modo.com.ar/promos/api/rewards`.

| Call | Purpose |
| --- | --- |
| `GET /categories` | taxonomy (id → slug/title) for category names |
| `GET /banks?source=hub` | all **82 banks** + each bank's official promo URL; used to canonicalize the `issuer` name per card |
| `GET /slots?source=hub&page=N` | the **full paged catalog** (`{ data:{ cards }, metadata:{ pagination } }`) — ~26k promos, 10/page |

Each `card` → one `promotions` row. We extract: `title`, `issuer` (the bank —
from the adhered-bank list when present, else matched against `/banks`),
`valid_from`/`valid_to` (`start_date`/`stop_date`), `weekdays`
(`days_of_week` "LMXJVSD"), `payment_methods` (`debit_list`/`credit_list` card
networks → `DEBITO`/`CREDITO` + `VISA`/`MASTER`/…), `purchase_modes`
(`payment_flow`), `max_discount_pct` (parsed from the discount text), and
`category`. Cross-bank promos keep the adhered-bank list in `tags`. Pagination
fans out with a small **concurrency pool** (6) so ~2,600 pages finish well inside
the run timeout. Tune/limit via `promo_providers.config` (`maxPages`, `source`,
`baseUrl`) — DB-driven, no redeploy.

### How BBVA is fetched (verified, all public `GET`)

BBVA's benefits page (`bbva.com.ar/beneficios`, a Next.js SPA) is backed by the
public **Go / "willgo"** JSON API — no auth, browser headers only. Base:
`https://go.bbva.com.ar/willgo/fgo/API`.

| Call | Purpose |
| --- | --- |
| `GET /v3/communications?pager=N` | the **paged benefits list** (`{ code, message, data:[…] }`, 20/page, ~46 pages). `message` reports totals (`"Comunicaciones: 908  paginas: 46"`) |
| `GET /v3/communication/{id}` | one benefit (bases/conditions, sales channels, `beneficios` block) — not needed for the card, so we skip the ~900 extra calls |
| `GET /v3/rubros/filtro?filtro_padre=true` | category taxonomy |

Each list item → one `promotions` row (issuer='BBVA'). We map: `cabecera`→title,
`subcabecera`→subtitle, `fechaDesde`/`fechaHasta`→`valid_from`/`valid_to`,
`grupoTarjeta`→`payment_methods` (crédito/débito → `CREDITO`/`DEBITO`),
`max_discount_pct` (parsed from the title/subtitle), `montoTope`→a `cap` tag, and
the MODO flag (`esModo`)→a `channel` tag. We enumerate `pager=0…` until an empty
page. `promo_providers.config.maxPages` caps it (default 200; catalog is ~46).

### Snapshot deduplication (history growth)

The canonical `promotions` table is fixed-size (deduped by
`provider_id + external_id`, upserted in place each run). To stop the
**history** table growing by ~20k rows/week, each promotion carries a
`content_hash` (SHA-256 of its meaningful fields, migration `030`). A run writes
a `promotion_snapshots` row **only for new or changed promotions** — unchanged
ones are refreshed in place with no snapshot. First run = full baseline; after
that, only the weekly delta. The run summary reports `snapshotted` vs
`unchanged`.

### How Naranja X is fetched (verified, all public `POST`/`GET`)
| Call | Purpose |
| --- | --- |
| `GET  /data-for-filter` | taxonomy → the list of active **category keys** to iterate |
| `POST /binder/filter` body `{filters:{categories:[{key}]}, pageOptions:{page,size}}` | the **full promo list**, paged, per category (`info.total` drives pagination) |
| `GET  /aspects/featured` | homepage carousel → best-effort `is_featured` flag |

Enumeration = iterate every active category and page through `/binder/filter`.
Each returned **binder** (commerce card) → one `promotions` row; its `plans[]`
(e.g. "25% off" + "12 cuotas cero interés") are stored as `jsonb`, with
aggregate `payment_methods` / `weekdays` / `purchase_modes` and convenience
`max_discount_pct` / `max_installments` extracted for filtering.

> All calls require **realistic browser headers** (`User-Agent`, `Origin`,
> `Referer`, `Accept`) or Cloudflare serves a challenge page. The provider sets
> them; see `BROWSER_HEADERS` in `src/promos/naranjax.ts`.

### How to run it
```bash
# 0. Apply the migrations first (Supabase SQL editor):
#    029_promos.sql → 030_promotions_content_hash.sql → 031_promos_issuer_and_modo.sql
#    → 032_promos_bbva.sql → 033_promos_galicia_macro_santander.sql
#    → 034_promos_icbc.sql → 035_promos_cuentadni.sql

# 1. Reachability check (no DB writes, no AI):
npm run promos:doctor

# 2. One-shot scrape into the DB (forces a run even if PROMOS_ENABLED=false):
npx tsx --env-file=.env scripts/promos-run.ts               # all providers
npx tsx --env-file=.env scripts/promos-run.ts --provider=naranjax
npx tsx --env-file=.env scripts/promos-run.ts --provider=modo       # the hub (~26k promos)
npx tsx --env-file=.env scripts/promos-run.ts --provider=bbva       # public JSON (~900)
npx tsx --env-file=.env scripts/promos-run.ts --provider=cuentadni  # plain JSON (~25, no browser)
# Playwright providers (F5-WAF'd / token-gated — launch a real Chromium, fetch in-page):
npx tsx --env-file=.env scripts/promos-run.ts --provider=galicia    # ~1.7k
npx tsx --env-file=.env scripts/promos-run.ts --provider=macro      # per-province, deduped
npx tsx --env-file=.env scripts/promos-run.ts --provider=santander  # brands→benefits
npx tsx --env-file=.env scripts/promos-run.ts --provider=icbc       # per-rubro (~337)
npx tsx --env-file=.env scripts/promos-run.ts --dry-run     # fetch only, no writes
# NB: use `npx tsx` directly — PowerShell drops `--` in `npm run … -- <flags>`.

# 3. Weekly automation: PROMOS_ENABLED defaults to true, so the cron
#    (PROMOS_CRON, default Mon 05:00 AR) activates on deploy — no env change.
#    Set PROMOS_ENABLED=false to pause. Manual trigger of the scheduled path:
npx tsx --env-file=.env src/orchestrator/index.ts --promos-now
```

<a id="how-to-call-the-data"></a>
### How to call the data (API)

Base: same server/domain as the main API, path prefix **`/v1/promos`**. Auth:
**`X-API-Key`** with the **`promos`-scoped** key (key name `promos-dashboard`).
A promos key gets `403` on every other route; the existing full-access client
key gets `403` on `/v1/promos/*`. The data never crosses over.

```bash
KEY=<the promos-dashboard key>            # shown once when created
BASE=https://<your-api-host>

# Filter taxonomy for the dashboard UI (providers, categories, enums)
curl -s -H "X-API-Key: $KEY" "$BASE/v1/promos/filters"

# Providers + active counts + last run time
curl -s -H "X-API-Key: $KEY" "$BASE/v1/promos/providers"

# Paginated, filterable list (e.g. all Galicia promos seen via MODO)
curl -s -H "X-API-Key: $KEY" \
  "$BASE/v1/promos?provider=modo&issuer=Galicia&weekday=WEDNESDAY&minDiscount=20&page=1&limit=20"

# One promotion (full detail incl. plans + raw)
curl -s -H "X-API-Key: $KEY" "$BASE/v1/promos/<id>"
```

**`GET /v1/promos` query params** (all optional, AND-combined):
`provider` (`naranjax`|`modo`|`bbva`|`galicia`|`macro`|`santander`|`icbc`|`cuentadni`), `issuer` (bank name, substring), `category`,
`paymentMethod`, `weekday`, `purchaseMode`, `merchant` (substring search),
`minDiscount` (int %), `featured` (`true|false`), `activeOnly` (default `true`),
`page`, `limit`. Enum + issuer values come from
`GET /v1/promos/filters`. Responses use the standard envelope
(`{data, pagination, meta}` for lists, `{data, meta}` for single). See
`examples/api/promos-*.json` for exact shapes.

### Adding another provider later
1. Write `src/promos/<bank>.ts` implementing `PromoProvider` (`fetchAll`).
2. `register(<bank>Provider)` in `src/promos/registry.ts`.
3. `INSERT INTO promo_providers (id, name, base_url) …`.
The pipeline, storage, API, and dashboard are provider-agnostic — no engine
changes. A provider may `fetch` JSON (like Naranja X), parse HTML, or use AI;
the engine only cares about the returned `NormalizedPromotion[]`.

> **Which banks to add, in what order, and how hard each is:** see the provider
> roadmap in [`BANK_PROMOS_ROADMAP.md`](./BANK_PROMOS_ROADMAP.md) (MODO, Galicia,
> Macro, BBVA Go, Santander, BNA+, Cuenta DNI, Mercado Pago). Key insight: **MODO
> is a hub** that aggregates ~30+ banks, so it's the highest-ROI next provider.

---

## 0. Hard requirement: isolation from the existing client

The promotions data **must never reach the current (supermarket-pricing)
client**, and their API key must not be able to read it.

- **Data:** new tables only (`promo_providers`, `promotions`,
  `promotion_snapshots`). We never write to `price_snapshots`, `client_base`,
  or any existing view. The daily supermarket scrape (`src/orchestrator/
  enqueue.ts`) already filters by `config.source_type` / `metadata.source`, so
  this pipeline is invisible to it.
- **API:** a **new path prefix** `/v1/promos/*` on the **same** server/domain
  (your instinct was right — same URL, new path), gated by a **new `promos`
  scope**. See §7 for the exact isolation mechanism — there is a subtlety:
  today a *full-access* key (which the current client almost certainly has)
  bypasses scope checks, so `/v1/promos/*` needs an **explicit route guard**
  that rejects non-`promos` keys, not just the standard `enforceScopes`.

---

## 1. Why this exists

The existing platform tracks **product prices** across supermarkets. This is a
different axis: **payment-method promotions** — "10% off with NX crédito on
Wednesdays", "12 cuotas sin interés en Disco", etc. — published by banks/card
issuers, not by the stores. The client wants a small dashboard to browse and
filter these, refreshed roughly **weekly**.

The two datasets never mix: one is "how much does product X cost at store Y",
the other is "what discount does card Z give at merchant W".

---

## 2. Feasibility findings — Naranja X (verified)

Naranja X's promos page (`https://www.naranjax.com/promociones/`) is an Angular
SPA behind Cloudflare, but it is backed by a **clean JSON BFF API**. We do
**not** need HTML parsing or AI extraction (unlike revistas). Base URL:

```
https://bkn-promotions.naranjax.com/bff-promotions-web/api
```

### Endpoints mapped

| Path | Returns | Access (server-side) |
| --- | --- | --- |
| `/data-for-filter` | Full taxonomy: 20 categories (with keys), weekdays, payment methods, online/in-store, discount %, installment plans | **Public** with browser headers ✅ |
| `/aspects/featured` | Homepage carousel promos (structured) | **Public** with browser headers ✅ |
| `/contentful/entries?content_type=nx23Page&fields.slug=home&include=10` | Curated homepage sections (e.g. "Para tarjetear la compra del super" → Disco, Jumbo, Vea, Changomas, Makro, Diarco, Carrefour) | **Public** with browser headers ✅ |
| `/binder/filter` | **Full filterable promo list** (all promos) | **Public `POST`** with browser headers ✅ |
| `/binder/{commerce}/detail/{slug}` | **Full promo detail** | **Public `POST`** with browser headers ✅ |

> **Correction (verified during implementation):** the `binder/*` endpoints are
> **not** token-gated. The earlier `403 {"message":"Missing Authentication
> Token"}` was AWS API Gateway rejecting the wrong **HTTP method** — both are
> **`POST`**, not `GET`. `POST /binder/filter` needs a body
> `{filters:{categories:[{key}]}, pageOptions:{page,size}}` (an empty filter
> `400`s; a category key returns the list). No Auth0 token, no Playwright. The
> "auth wrinkle" subsection below is kept for history but is **obsolete**.

"Public with browser headers" = a plain `fetch`/`curl` returns `200` **only if**
we send realistic headers (`User-Agent`, `Origin: https://www.naranjax.com`,
`Referer: https://www.naranjax.com/promociones/`, `Accept: application/json`).
Without them, Cloudflare serves a managed-challenge page (`403`, ~5.5 KB HTML).

### Sample: `/aspects/featured` item (real payload)

```json
{
  "id": "01M1Y443VWXEB7ZY78R55H03MK",
  "name": "puma_sept2026",
  "link": "https://www.naranjax.com/promociones/AUTOS_Y_MOTOS/GOMERIA/puma_energy/10_off-10_de_descuento-C",
  "dateFrom": "2026-09-07T03:00:00.000Z",
  "dateTo": "2026-09-30T03:00:00.000Z",
  "backImageNameDesktop": "https://promotion-featured-images.naranjax.com/puma_sept2026-desktop.webp",
  "validity": "Miércoles",
  "title": "10% OFF",
  "clarification": "Tope de 50 litros por semana",
  "commerceNameOrCategory": "Puma",
  "paymentMethods": ["credito"],
  "captureMethods": [{ "extra": { "name": "Puma Priss" }, "key": "APP" }]
}
```

### Sample: `/binder/{commerce}/detail/{slug}` (rendered fields)

The detail endpoint returns fully structured data — no scraping of prose needed:

- Merchant + category (e.g. `Puma Energy` / `Servicios | Transportes`)
- Headline (`10% off`)
- **Valid weekdays** (L-M-M-J-V-S-D flags)
- Validity window (`Hasta el 30/SEP`)
- **Payment method** (`Crédito · Con App Puma Pris`)
- **Minimum purchase** (`Sin monto mínimo`)
- **Savings cap / "tope"** (`Sin tope` or "tope 50 litros/semana")
- **How it applies** (`Descuento en el punto de venta`)
- Channel (in sucursales / online)
- **Full Términos y condiciones** text

### Taxonomy (from `/data-for-filter`, for dashboard filters)

- **Categories (20):** `SUPERMERCADOS`, `GASTRONOMIA`, `COMBUSTIBLE`,
  `TRANSPORTES`, `MODA_Y_ACCESORIOS`, `ELECTRO_Y_TECNOLOGIA`,
  `VIAJES_Y_TURISMO`, `ENTRETENIMIENTO`, `SALUD_Y_BIENESTAR`, `HOGAR_Y_DECO`,
  `CONSTRUCCION`, `AUTOS_Y_MOTOS`, `SERVICIOS`, `DEPORTES`, `ALIMENTOS`,
  `JUGUETERIA`, `EDUCACION`, `MASCOTAS`, `LIBRERIAS`, `OTROS` (+ `COMPRA_ONLINE`)
- **Payment methods:** `CREDITO` (NX crédito), `DEBITO` (NX débito), `DINERO`
  (dinero en cuenta), `VISA`, `MASTER`, `AMEX`
- **Purchase modes:** `ONLINE`, `IN_STORE`
- **Weekdays:** Mon-Sun + `ALL_DAYS`
- **discounts.benefits:** list of discount-percent buckets
- **installments.plans:** list of cuotas plans

### The auth wrinkle (and why it's low-risk)

The `binder/*` endpoints return AWS API Gateway `403 {"message":"Missing
Authentication Token"}` from a plain server-side request, but **anonymous
browsers reach them fine** (the detail page renders full data with no login).
The Angular app injects request context via an HTTP interceptor; the token is
read from an `auth0User` cookie (`getTokenCookie()` in the bundle), which for
anonymous visitors is obtained programmatically at app startup. So the token is
**machine-obtainable**, not a human login.

**Two implementation strategies (token-first, per decision):**

1. **Token replay (preferred):** reproduce the app's anonymous-token
   acquisition (Auth0 anonymous/client token → `Authorization: Bearer …`) plus
   the browser headers, then call `binder/*` with plain `fetch`. Cheapest at
   runtime; same spirit as the Coto/VTEX adapters.
2. **Playwright render + response interception (fallback):** load the real
   pages headless and capture the JSON the app fetches — the exact pattern
   already used in `src/adapters/maxi-carrefour-auth.ts`. Since this runs
   **weekly**, the cost is negligible. Confirmed working: detail pages render
   full structured data headless.

Even in the worst case (strategy 1 fully blocked), strategy 2 guarantees we can
get everything. **Feasibility is not in doubt.**

---

## 3. Architecture

Mirrors the revistas/instore pattern: a self-contained module + one orchestrator
hook + one route file. **Provider-based** (the analog of "adapters"): Naranja X
is provider #1; adding another bank = one new file + one DB row.

```
src/promos/
  types.ts        ← PromoProvider contract, NormalizedPromotion type
  registry.ts     ← id → provider (mirrors src/adapters/registry.ts)
  naranjax.ts     ← provider #1: fetch featured + binder list + details
  naranjaxAuth.ts ← anonymous-token acquisition (+ Playwright fallback)
  normalize.ts    ← raw provider JSON → NormalizedPromotion (shared taxonomy)
  store.ts        ← upsert promotions + write weekly snapshot (dedup by provider+external_id)
  pipeline.ts     ← runPromoCheck(): the weekly entry point (called by orchestrator)
  config.ts       ← env-derived settings (enabled flag, cron, provider toggles)

src/api/routes/promos.ts   ← GET /v1/promos, /v1/promos/:id, /v1/promos/providers, /v1/promos/filters

migrations/029_promos.sql  ← new tables (next free number; 028 is the latest today)

scripts/promos-run.ts      ← npm run promos:run  (manual/backfill, one provider or all)
scripts/promos-doctor.ts   ← npm run promos:doctor (diagnose provider reachability, no writes)
```

### Provider contract (sketch)

```ts
// src/promos/types.ts
export interface PromoProvider {
  id: string;                 // 'naranjax'
  name: string;               // 'Naranja X'
  /** Discover + fetch every current promotion, normalized. */
  fetchAll(ctx: PromoContext): Promise<NormalizedPromotion[]>;
}

export interface NormalizedPromotion {
  providerId: string;
  externalId: string;         // stable id from the source (e.g. binder slug or ULID)
  title: string;              // "10% OFF"
  merchant: string | null;    // "Puma"
  category: string | null;    // mapped to our taxonomy key
  paymentMethods: string[];   // ['CREDITO', ...] normalized
  weekdays: string[];         // ['WEDNESDAY'] | ['ALL_DAYS']
  purchaseModes: string[];    // ['IN_STORE','ONLINE']
  discountPct: number | null; // parsed when present
  installments: number | null;
  minPurchase: string | null;
  cap: string | null;         // "tope 50 litros/semana"
  howApplied: string | null;  // "Descuento en el punto de venta"
  validFrom: string | null;   // ISO
  validTo: string | null;
  url: string | null;
  imageUrl: string | null;
  terms: string | null;       // full T&C text
  raw: Record<string, unknown>; // original payload, for reprocessing
}
```

---

## 4. Data model (migration `029_promos.sql`)

Same Supabase project, new isolated tables. Weekly **snapshots** for history.

```sql
-- Providers (banks/issuers). Analog of `supermarkets`.
CREATE TABLE IF NOT EXISTS promo_providers (
  id          text PRIMARY KEY,              -- 'naranjax'
  name        text NOT NULL,                 -- 'Naranja X'
  base_url    text,
  active      boolean NOT NULL DEFAULT true,
  config      jsonb   NOT NULL DEFAULT '{}', -- tokens/headers/toggles (DB-driven, no redeploy)
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Canonical, de-duplicated promotion (latest known state). One row per
-- (provider, external_id). Updated in place each run; history in snapshots.
CREATE TABLE IF NOT EXISTS promotions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id    text NOT NULL REFERENCES promo_providers(id),
  external_id    text NOT NULL,
  title          text,
  merchant       text,
  category       text,
  payment_methods text[],
  weekdays       text[],
  purchase_modes text[],
  discount_pct   numeric,
  installments   int,
  min_purchase   text,
  cap            text,
  how_applied    text,
  valid_from     timestamptz,
  valid_to       timestamptz,
  url            text,
  image_url      text,
  terms          text,
  first_seen     timestamptz NOT NULL DEFAULT now(),
  last_seen      timestamptz NOT NULL DEFAULT now(),
  is_active      boolean NOT NULL DEFAULT true,  -- false once it drops off the source
  UNIQUE (provider_id, external_id)
);

-- Weekly snapshot: what the promotion looked like on a given run. History.
CREATE TABLE IF NOT EXISTS promotion_snapshots (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id  uuid NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  run_id        uuid,                          -- groups a weekly run
  captured_at   timestamptz NOT NULL DEFAULT now(),
  payload       jsonb NOT NULL                 -- full NormalizedPromotion at capture time
);

CREATE INDEX IF NOT EXISTS idx_promotions_provider ON promotions(provider_id);
CREATE INDEX IF NOT EXISTS idx_promotions_category ON promotions(category);
CREATE INDEX IF NOT EXISTS idx_promotions_active   ON promotions(is_active);
CREATE INDEX IF NOT EXISTS idx_promo_snap_promo    ON promotion_snapshots(promotion_id);
CREATE INDEX IF NOT EXISTS idx_promo_snap_run      ON promotion_snapshots(run_id);
```

**Upsert logic (`store.ts`):** for each `NormalizedPromotion`, upsert into
`promotions` by `(provider_id, external_id)` (refresh fields + `last_seen`,
`is_active=true`); insert a `promotion_snapshots` row every run. After a run,
mark promotions **not** seen this run as `is_active=false` (they expired /
dropped off) — history is preserved in snapshots.

---

## 5. Scraping flow (`pipeline.ts` → `runPromoCheck`)

```
runPromoCheck({ runId }):
  for each active provider (registry):
    promos = provider.fetchAll(ctx)      // token-first, Playwright fallback
    store.upsertAll(providerId, promos, runId)
  store.deactivateMissing(runId)         // expire promos not seen this run
  (optional) Telegram summary: "Naranja X: 148 promos (12 new, 5 expired)"
```

For Naranja X specifically, `fetchAll`:
1. Acquire anonymous token/headers (`naranjaxAuth.ts`).
2. `GET /binder/filter` (paged) → list of promo refs (commerce + slug).
3. `GET /binder/{commerce}/detail/{slug}` per promo → full detail.
4. `normalize.ts` maps each to `NormalizedPromotion` using the taxonomy keys.
5. Also fold in `/aspects/featured` for the "destacadas" flag.

Rate-limited + concurrency-capped like the adapters; weekly cadence means we can
be gentle (e.g. 1 req at a time, small delay) and still finish quickly.

---

## 6. Scheduling

Add a **weekly** cron alongside the existing `SWEEP_CRON` pattern in
`src/orchestrator/index.ts`:

- New env var `PROMOS_CRON` (default e.g. `0 5 * * 1` — Mondays 05:00 AR).
- New env var `PROMOS_ENABLED` (default `false` until we go live).
- Gated + timeout-wrapped like `runRevistaCheck`.
- Manual trigger: `npm run promos:run -- [--provider=naranjax] [--dry-run]`
  and an orchestrator flag `--promos-now` (mirrors `--sweep-now`).

---

## 7. API surface & isolation (`/v1/promos/*`)

All routes go through the existing envelope (`success`/`paginated`) and zod
parsing, mounted after the `/v1` auth stack in `src/api/app.ts`.

### Isolation mechanism (critical)

1. **Register the scope prefix** in `src/api/middleware/auth.ts`:
   ```ts
   const SCOPE_PREFIXES: Record<string, string> = {
     'in-store': '/v1/in-store',
     'promos':   '/v1/promos',   // NEW
   };
   ```
   This makes a `promos`-scoped key reach only `/v1/promos/*`.
2. **Add an explicit route guard** so a *full-access* key (the current client)
   is **rejected** — the inverse of the in-store `requireFullAccess` guard:
   ```ts
   // src/api/routes/promos.ts
   function requirePromosScope(req: Request): void {
     const scopes = req.apiKey?.scopes;
     if (!scopes?.includes('promos')) {
       throw ApiError.forbidden('Requires a promos-scoped API key');
     }
   }
   promosRouter.use((req, _res, next) => { requirePromosScope(req); next(); });
   ```
   Net effect: the supermarket client key → `403` on `/v1/promos/*`; the
   dedicated promos key → `403` everywhere except `/v1/promos/*`.
3. **Issue the key:** `npm run apikey:create -- promos-dashboard --scope=promos`
   (the create script validates `--scope` against `SCOPE_PREFIXES`).

### Endpoints (proposed)

| Method & path | Purpose |
| --- | --- |
| `GET /v1/promos` | Paginated, **filterable** list (see filters below) |
| `GET /v1/promos/:id` | One promotion (full detail incl. terms) |
| `GET /v1/promos/providers` | List providers + counts + last-run time |
| `GET /v1/promos/filters` | The taxonomy for building the dashboard filter UI |

**`GET /v1/promos` query filters** (all optional, AND-combined):
`provider`, `category`, `paymentMethod`, `weekday`, `purchaseMode`,
`minDiscount`, `merchant` (search), `activeOnly` (default true), `page`,
`limit`. Response item ≈ the `promotions` row shape above.

> When these routes are added, update `API.md` and add
> `examples/api/promos-list.json` + `promos-detail.json` fixtures in the same
> change (repo convention).

---

## 8. Dashboard

A small separate dashboard (built by the frontend team against `/v1/promos/*`
with the `promos` key). Core UX: a filterable/searchable grid of promo cards
(image, merchant, headline, payment method chips, validity, discount), with
left-rail filters driven by `GET /v1/promos/filters`. History view (optional):
per-promo timeline from `promotion_snapshots`.

---

## 9. Phased plan

- **Phase A — Recon done (this doc).** Naranja X API mapped; feasibility
  confirmed; isolation mechanism identified.
- **Phase B — Data + provider MVP.** Migration `029`, `promo_providers` seed
  (naranjax), provider contract + registry, Naranja X `fetchAll` (token-first,
  Playwright fallback), `normalize.ts`, `store.ts`. `npm run promos:run`
  end-to-end into the DB. `npm run promos:doctor`.
- **Phase C — API + isolation.** `/v1/promos/*` routes, `promos` scope +
  guard, scoped key, `API.md` + fixtures.
- **Phase D — Schedule + notify.** `PROMOS_CRON` weekly hook, Telegram summary,
  `--promos-now`. Flip `PROMOS_ENABLED=true`.
- **Phase E — Dashboard** (frontend) + **more providers** (one file each).

---

## 10. Open questions / risks

- **Auth durability (low-med):** if Naranja X rotates the anonymous-token flow,
  strategy 1 breaks; the Playwright fallback (already-owned pattern) covers it.
- **Cloudflare (low):** public endpoints pass with realistic headers today;
  Playwright covers any future tightening.
- **Provider diversity (later):** other banks may publish as HTML/PDF, not JSON.
  The provider abstraction absorbs that (a provider can parse HTML like
  `atomo.ts`, or use AI like revistas, without changing the engine).
- **Discount parsing:** `discountPct`/`installments` need light parsing from
  titles/fields; keep raw payload so we can reprocess without re-scraping.
- **Legal/ToS:** read-only, weekly, low-volume, public promo data — but worth a
  sign-off before go-live.

---

## 11. Environment variables (new)

```
# Bank/card promotions module
PROMOS_ENABLED=false            # master switch (default off until live)
PROMOS_CRON=0 5 * * 1           # weekly, Mondays 05:00 (TZ = America/Argentina/Buenos_Aires)
# Provider secrets/toggles live in promo_providers.config (DB-driven), env is fallback only.
```

Added to `src/shared/env.ts` with sensible defaults so startup never breaks.
