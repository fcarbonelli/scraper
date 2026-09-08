# Bank & Card Promotions — Provider Roadmap

Companion to [`BANK_PROMOS.md`](./BANK_PROMOS.md) (the built module). This is the
**expansion roadmap**: which banks/wallets to add, where their promo catalogs
live, how hard each is to scrape, and the recommended build order. Each provider
maps to **one file** `src/promos/<provider>.ts` + **one `promo_providers` row**
— the pipeline, storage, API, and dashboard are already provider-agnostic.

> Status: **8 providers BUILT** — `naranjax` + `modo` + `bbva` + `galicia` +
> `macro` + `santander` + `icbc` + `cuentadni`. Effort tags are rough (S/M/L)
> relative to Naranja X.
>
> **Latest round shipped ICBC + Cuenta DNI.**
> - **ICBC** — public JSON API (`prod-utilidades-icbc.pisol.net/api/web/v1`)
>   organized by rubro; calls carry an `apikey` + `accesstoken` the SPA injects,
>   so the adapter captures both in-page via `browserFetch` (Playwright) and
>   paginates each rubro. Verified live: **337 merchant-level promos**.
> - **Cuenta DNI** (Banco Provincia — the only wishlist issuer NOT on MODO) turned
>   out to have a **clean plain-fetch JSON API** (`/cuentadni/Home/GetBeneficioByRubro`)
>   after all — **no WAF, no Playwright**. The adapter discovers active rubro ids
>   from the server-rendered page (`filtrarPorRubro(<id>)`), fetches each, and
>   keeps only current (not hidden/expired) rows. Verified: **25 current
>   category-level wallet promos**.
>
> **The prior round shipped the F5-walled trio** (Galicia/Macro/Santander), all
> behind an **F5 BIG-IP WAF that fingerprints the TLS handshake (JA3)** — plain
> `fetch`/`curl` rejected. The shared **browser-fetch helper**
> (`src/promos/browserFetch.ts`) drives a real Chromium and calls the API
> **in-page** (real Chrome JA3 + correct CORS). Verified live (Galicia 1,713;
> Macro ~190/province; Santander rich per-brand).
>
> Remaining candidates: **BNA+** (thin web, mostly on MODO), **Mercado Pago**
> (app-only personalized catalog) — both low marginal value now.

---

## 0. The key insight: MODO is a hub  ✅ BUILT

**MODO** (`modo.com.ar/promos`) is the banks' shared wallet, and its public promos
page aggregates offers across **82 banks/wallets** into one searchable catalog.
This is now implemented in **`src/promos/modo.ts`** and confirmed live:

- **Public API base** (proxied on the site's own origin, no auth, browser headers
  only): `https://www.modo.com.ar/promos/api/rewards`
  - `GET /categories` → taxonomy (id → slug/title)
  - `GET /banks?source=hub` → **all 82 banks + each bank's official promo URL**
    (this table's "Promo catalog URL" column was filled from here)
  - `GET /slots?source=hub&page=N` → the full paged catalog
    (`{ data:{ cards:[…] }, metadata:{ pagination } }`) — **~26,000 promotions**,
    10 per page.
- Each card carries: `title`, `start_date`/`stop_date`, `days_of_week`
  ("LMXJVSD"), `debit_list`/`credit_list` (card networks), a discount/tope text
  row, the issuing bank, and (for cross-bank promos) the full adhered-bank list.
- We extract the **`issuer`** (bank) per card — the key filter dimension — using
  MODO's own `/banks` list to canonicalize names.

Consequence for sequencing (still holds):

- **MODO (done)** gives broad coverage of every bank's *pay-with-MODO* promos in a
  single integration — including all the banks listed below.
- Each **bank's own site** then adds its *card-specific* promos (many are NFC /
  Apple-Pay / Google-Pay / card-only, i.e. NOT surfaced through MODO).
- Expect **overlap** between MODO and each bank. Cross-provider de-dup uses the
  new `issuer` column (see §4).

---

## 1. Provider matrix

Difficulty tiers by scraping approach (same spirit as our supermarket adapters):

- **Tier A — JSON-API SPA** (like Naranja X): sniff the BFF/JSON endpoint, direct
  `fetch` + normalize. Best ROI.
- **Tier B — SPA/HTML, thinner public catalog or partly app/login-gated**: scrape
  the public catalog where present; otherwise reverse a mobile API or defer.
- **Tier C — editorial/monthly page or app-only**: small fixed set (AI-read or
  light HTML parse) or hard mobile-API work.

| Provider | Promo catalog URL | Tech (expected) | Tier | Effort | MODO covers it? | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| **Naranja X** | `naranjax.com/promociones` | JSON BFF (built) | A | ✅ done | n/a | Reference impl (`naranjax.ts`). |
| **MODO** | `www.modo.com.ar/promos/api/rewards/slots?source=hub` | SPA + public JSON API | A | ✅ **done** | — (it *is* the hub) | `modo.ts`. One scrape → **82 banks / ~26k promos**. `issuer` = the bank. |
| **BBVA** | `go.bbva.com.ar/willgo/fgo/API/v3/communications?pager=N` | **Go** public JSON API (`bbva.com.ar/beneficios` Next.js SPA) | A | ✅ **done** | ✅ via MODO | `bbva.ts`. **~900 promos / 46 pages**, no auth (browser headers). List = `/v3/communications`; detail = `/v3/communication/{id}`; cats = `/v3/rubros/filtro`. issuer='BBVA'. |
| **Banco Galicia** | `loyalty.bff.bancogalicia.com.ar/api/portal/personalizacion/v1/promociones/catalogo?page=N` | Next.js SPA (`beneficios.galicia.ar`) + BFF | A | ✅ **done (Playwright)** | ✅ via MODO | `galicia.ts`. **1,713 public promos**, flat paginated catalog. F5 WAF (JA3) → in-page fetch via `browserFetch`. Headers: `accept: application/vnd.iman.v1+json` + `id_canal`/`id_channel`. issuer='Banco Galicia'. |
| **Banco Macro** | `apipublic.macro.com.ar/v1/card-benefits/provinces/{code}?offset=N` | SPA (`macro.com.ar/beneficios`) + public API | A | ✅ **done (Playwright)** | ✅ via MODO | `macro.ts`. Per-province (ISO 3166-2:AR) paginated; national promos de-duped. F5 WAF (`/TSPD/`) + a public `apikey` captured in-page. `discount`/`sector`/`days-week`/`payment`. issuer='Banco Macro'. |
| **Santander** | `www.santander.com.ar/bff-benefits/brands` + `/brands/{id}` | SPA + same-origin BFF (behind WAF) | A | ✅ **done (Playwright)** | ✅ via MODO | `santander.ts`. List all brands → fetch each brand's benefits (customerDiscount, topAmount, day flags, dates, T&C). Same-origin in-page fetch. issuer='Banco Santander'. |
| **Banco Nación (BNA+)** | `semananacion.com.ar/semananacion` | Campaign site / mostly in-app | B | M–L | ✅ via MODO (strongly) | Thin public web; lean on MODO, add web catalog if an API exists. |
| **Banco Provincia (Cuenta DNI)** | `bancoprovincia.com.ar/cuentadni/Home/GetBeneficioByRubro?idRubro=<id>` | ASP.NET JSON API behind a CMS grid | C | ✅ **done (plain fetch)** | ❌ **No** (Cuenta DNI ≠ MODO) | `cuentadni.ts`. **Highest marginal value** — the only wishlist issuer not on MODO. Turned out to have a clean plain-fetch JSON API (no WAF, no Playwright). Active rubro ids discovered from the page (`filtrarPorRubro(<id>)`); keep only current (not hidden/expired) rows. **~25 category-level wallet promos**. issuer='Cuenta DNI'. |
| **ICBC** | `prod-utilidades-icbc.pisol.net/api/web/v1/beneficios/get?heading_id=<rubro>&offset=N` | Vite SPA (`beneficios.icbc.com.ar`) + public API | A/B | ✅ **done (Playwright)** | ✅ via MODO | `icbc.ts`. **337 merchant-level promos** across 15 rubros. Calls carry an `apikey` + `accesstoken` the SPA injects → captured in-page via `browserFetch`. Enumerate rubros (`/beneficios/rubros`) → paginate `/beneficios/get`. issuer='ICBC'. |
| **Mercado Pago** | `promociones.mercadopago.com.ar` (**WordPress**) | WP editorial `/seller/*` + app API | C | **L** | ❌ **No** | Confirmed: public site is a WP/Elementor editorial set (`/seller/<name>/`, scrapable via `wp-json`); the personalized card catalog is **app-only**. Defer or do a light WP-REST Tier-C pass. |

Other banks worth adding later (all via MODO first): **ICBC, Patagonia,
Supervielle, Credicoop, Comafi, Ciudad, Brubank, Uala, Personal Pay**.

---

## 2. Recommended build order

1. ✅ **MODO** (Tier A, hub) — **DONE**. Biggest coverage-per-effort; established
   the multi-bank shape + the `issuer` column.
2. ✅ **BBVA Go** (Tier A) — **DONE**. Clean public JSON API; ~900 card promos.
3. ✅ **Browser-fetch helper + Galicia + Macro + Santander** — **DONE**. Built
   `src/promos/browserFetch.ts` (launch Chromium → navigate to the SPA origin →
   run the API `fetch` in-page → JSON), then the three F5-WAF'd issuers on top.
4. ✅ **ICBC** (Tier A/B) — **DONE (Playwright)**. Public rubro-paginated API;
   `apikey` + `accesstoken` captured in-page. 337 merchant-level promos.
5. ✅ **Banco Provincia / Cuenta DNI** (Tier C) — **DONE (plain fetch)**. The only
   listed bank not on MODO. Turned out to expose a clean ASP.NET JSON API (no
   WAF): discover active rubros from the page → fetch each → keep current rows.
   ~25 category-level wallet promos.
6. **BNA+** (Tier B) — mostly covered by MODO; thin public web. Low marginal value.
7. **Mercado Pago** (Tier C) — hardest; light WP-REST pass for the `/seller/*`
   editorial set, or defer the app-only personalized catalog.
8. **Frontend dashboard** — the module now exposes **eight** providers (Naranja X
   + MODO / 82 issuers + BBVA + Galicia + Macro + Santander + ICBC + Cuenta DNI),
   so filters/faceting can be built now. See [`DASHBOARD_GUIDE.md`](./DASHBOARD_GUIDE.md).

### The browser-fetch pattern (for future WAF'd banks)

`src/promos/browserFetch.ts` → `withPageFetcher({ origin, headers, captureHeaders,
launch }, fn)`: launches Chromium (system Edge/Chrome → bundled fallback),
navigates to the SPA origin, and hands `fn` a `getJson(url)` that runs the fetch
**inside the page**. This clears JA3 WAFs (real Chrome TLS) and CORS (correct
Origin). `captureHeaders` grabs a public token the SPA injects (e.g. Macro's
`apikey`, or ICBC's `apikey` + `accesstoken`) in-memory — never logged. Reuse it
for any future F5/Cloudflare bank. Per-provider launch tuning lives in
`promo_providers.config.launch` (`{ headless, useSystemChrome, browserChannel }`);
Macro accepts `config.provinces` to scope the province sweep.

**Not every bank needs it, though** — Cuenta DNI (`cuentadni.ts`) is a plain
server-side `fetch` (its ASP.NET API has no JA3 WAF). Always try `curl`/node
`fetch` first; only reach for `browserFetch` when the handshake is rejected or a
client token must be captured live.

Each step = `src/promos/<provider>.ts` + a `promo_providers` row + a
`registry.ts` line. No engine changes.

---

## 3. Per-provider recon checklist (before writing an adapter)

For each new provider, spend ~30 min confirming the cheapest path (this is exactly
how Naranja X was mapped):

1. Open the promo page; check if it's server-rendered HTML or an SPA.
2. DevTools → Network → XHR: find the JSON endpoint(s) the page calls
   (list + detail + taxonomy/filters).
3. Reproduce with `curl` + realistic browser headers (`User-Agent`, `Origin`,
   `Referer`, `Accept`). Note Cloudflare/WAF behavior.
4. Confirm method + body (Naranja X's list was a **POST**, not GET).
5. If token/login-gated: try anonymous token replay; else Playwright render +
   response interception (we already own that pattern), or defer.
6. Map the fields onto `NormalizedPromotion`; note what's provider-specific.

---

## 4. Data-model notes for multi-bank providers

The current `promotions` schema already fits banks, but two things differ from
Naranja X and are worth planning for:

- **Category-level promos** (e.g. "20% supermarkets on Wednesdays") often have
  **no single merchant** — `merchant` stays null; the adhered-merchant/brand list
  goes in `plans`/`raw`. Fine as-is.
- **Cross-provider de-dup / attribution** ✅ **implemented**: MODO + a bank's own
  site report overlapping offers. We added an **`issuer`** column
  (migration `031_promos_issuer_and_modo.sql`) so every promo is attributed to its
  bank ("Galicia", "Credicoop", "MODO" for cross-bank, "Naranja X"). Rows are
  still kept separate per `provider_id` (honest "as seen on MODO" vs "as seen on
  Galicia"), but the dashboard can now **group/filter/de-dup by `issuer`**. If a
  hard dedup key is ever needed, add it in a later migration — never edit `031`.
- **`promo_providers.config`** carries per-provider base URLs / headers / toggles
  (DB-driven, no redeploy) — reuse it for each bank's endpoint + any tuning.

---

## 5. Risks / watch-outs

- **App-only catalogs** (Mercado Pago, parts of BNA/Santander): the richest data
  is behind the mobile app. Reversing a mobile API is heavier and more brittle
  than a web BFF — weigh coverage vs effort; partial is OK.
- **Personalization/login**: some banks only show *your* eligible promos after
  login. Prefer the public/anonymous catalog; never store credentials.
- **WAF/Cloudflare**: expect it (as on Naranja X). Realistic headers first,
  Playwright fallback if needed.
- **Legal/ToS**: read-only, low-volume, weekly, public promo data — but get a
  sign-off before scaling to many banks.
- **Snapshot volume**: with content-hash dedup (migration `030`) already in place,
  each new provider only grows history by its weekly delta.
