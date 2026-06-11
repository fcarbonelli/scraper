# Adding a Supermarket — Playbook

A step-by-step guide for mapping a new supermarket into the scraper. Optimized
for the common case (**VTEX stores**, which are ~half the client list and take
~10 lines of code), with a section for non-VTEX sites at the end.

> Background reading: `AGENTS.md` → "Architecture: engine + adapters" and "How
> to add a new supermarket". This doc is the hands-on version with the exact
> commands, the VTEX factory, and the gotchas we've actually hit.

---

## 0. Mental model (30 seconds)

The system is **engine + adapters**. The engine (orchestrator/worker/api) is
site-agnostic and you never touch it. Adding a supermarket = one small adapter
file + a few one-line wiring changes + a DB row. The worker looks up
`getAdapter(supermarketId)` and calls `adapter.scrape(ctx)`.

Each adapter implements the `SupermarketAdapter` contract (`src/adapters/types.ts`):

| Method | When it runs | Purpose |
| --- | --- | --- |
| `canonicalizeUrl(url)` | ingest | Strip query/hash, lowercase host → the clean URL we store |
| `resolveExternalId(url)` | ingest (once per URL) | Derive the stable SKU/productId (URL parse, or one API call) |
| `searchByEan(ean)` | discovery | Find a product by barcode → `{ url, externalId }` or `null` |
| `scrape(ctx)` | every daily run | Return `ScrapeResult` (price/stock/...) or throw `ScrapeError` |
| `probe(ctx)` | ingest (optional) | Lightweight metadata for fast row creation |

---

## 1. Is it a VTEX store? (decide the path)

Most LATAM supermarkets run on **VTEX** (Carrefour, Vea, Jumbo, Disco, Día,
Libertad, Changomas, La Anónima is NOT, etc.). Tells:

- Product URLs end in **`/p`** (e.g. `/lavandina-ayudin-1l/p`).
- This endpoint returns JSON:
  `https://<host>/api/catalog_system/pub/products/search?fq=alternateIds_Ean:7793253005054`

If both are true → **VTEX path** (Section 2). Otherwise → **non-VTEX path**
(Section 5).

Quick check from a terminal:

```bash
curl -s "https://www.vea.com.ar/api/catalog_system/pub/products/search?fq=alternateIds_Ean:7793253005054" | head -c 300
```

A JSON array with a product object = VTEX confirmed.

---

## 2. VTEX path (the fast one)

All VTEX storefronts behave identically apart from their hostname, so we have a
factory: **`src/adapters/vtex.ts` → `createVtexAdapter({ id, name, host })`**.
It handles canonicalization, the slug→productId `pagetype` lookup, the
regionalized catalog scrape with geo-fallback, promotions, the `listPrice`
sanity guard, and `searchByEan`. You only supply id/name/host.

### 2.1 Write the adapter (~10 lines)

`src/adapters/<id>.ts`:

```ts
/**
 * Vea adapter (VTEX / Cencosud).
 * Standard VTEX storefront — all logic lives in the shared factory.
 */
import { createVtexAdapter } from './vtex.js';

export const veaAdapter = createVtexAdapter({
  id: 'vea',                 // must match supermarkets.id in the DB
  name: 'Vea',               // human-readable, used in logs/alerts
  host: 'www.vea.com.ar',    // storefront host, no protocol
});
```

Optional override if a chain needs a specific User-Agent:
`createVtexAdapter({ ..., userAgent: '<custom UA>' })`. The default is already a
realistic desktop-Chrome UA (see the WAF gotcha in Section 4).

### 2.2 Register it — `src/adapters/registry.ts`

```ts
import { veaAdapter } from './vea.js';
// ...
register(veaAdapter);
```

### 2.3 Route the hostname — `src/ingest/index.ts` (`detectSupermarket`)

```ts
if (host.includes('vea.com.ar')) return 'vea';
```

**Order matters**: more-specific hosts must be checked before generic ones (a
subdomain like `comerciante.carrefour.com.ar` must precede `carrefour.com.ar`).

### 2.4 Seed / activate the supermarket row — `scripts/setup-db.ts`

Many chains are already seeded as `is_active: false`. Flip the flag for yours
(or add a new entry if it doesn't exist):

```ts
{ id: 'vea', name: 'Vea', base_url: 'https://www.vea.com.ar',
  rate_limit_ms: 250, concurrency: 4, is_active: true, /* ...geo fields... */ },
```

`is_active: true` is what makes the daily run enqueue it. The DB only changes
when `npm run db:setup` runs (locally or on deploy — it's an idempotent upsert).

---

## 3. Verify before going live

No DB or Redis needed for these.

```bash
npm run typecheck

# Parse one real product end-to-end (canonicalize → resolveExternalId → scrape):
npm run test:adapter -- "https://www.vea.com.ar/<some-product>/p"
```

A healthy result prints a `ScrapeResult` with a sane `price`, `inStock`, the
`ean`, name, brand, and category.

Then check catalog coverage against the client's 211 EANs — **search only, no
writes**:

```bash
npx tsx --env-file=.env scripts/discover-products.ts --search-only vea
```

This prints `Found on site: N` and the list of matching EANs. Nothing is saved.

---

## 4. Gotchas we've actually hit

- **Cencosud WAF (Vea / Jumbo / Disco) → instant 429.** Their WAF blocks obvious
  bot User-Agents. The factory defaults to a real Chrome UA (`DEFAULT_USER_AGENT`
  in `vtex.ts`) which passes. If a new store still 429s on the *first* request,
  it's bot-blocking, not throughput — try the `userAgent` override, and if that
  fails we add the full browser header set (`sec-ch-ua`, `Referer`, cookies).
- **Garbage `listPrice` sentinel.** Some VTEX backends (Cencosud) put a huge
  number in `ListPrice` (e.g. `300413` against a `3635` real price), which would
  look like a ~99% discount. The shared parser ignores any `listPrice` more than
  **10× the selling price** (`MAX_LIST_PRICE_RATIO` in `vtex.ts`).
- **Regionalized stock/price.** VTEX filters availability by region. The factory
  tries the default sales channel first, then sweeps fallback zones
  (`src/adapters/zones.ts`) via a `regionId` (`src/adapters/vtex-region.ts`) when
  the default comes back missing/out-of-stock. Usually automatic; no action
  needed. For diagnosis: `npm run test:adapter -- <url> --all-zones`.
- **EAN not exposed.** A few sites (La Coope, Maxiconsumo) don't expose EAN, so
  master `products` can't be deduped by barcode for them. VTEX stores DO expose
  EAN, so dedupe works.
- **Discounts vs "promotions".** A crossed-out regular price + lower sale price
  is captured as `list_price` (regular) + `price` (sale) — NOT in the
  `promotions[]` array. `promotions[]` is only for *named* deals (payment-method
  offers, 2x1) that the site exposes explicitly. The client API surfaces the
  markdown correctly via the `client_base` view: `Precio_Regular` =
  `COALESCE(list_price, price)`, `Precio_c_Oferta_1` = the sale price, and
  `Descuento_Unitario` = the markdown gap (see `migrations/003`). So an empty
  `promotions: []` on a discounted product is expected and fine.

---

## 5. Going live (preview vs real ingest)

This is the step people get confused by. **`--search-only` writes nothing.** To
actually create rows so the product gets scraped:

```bash
# 1. Apply the is_active flags to the DB (REQUIRED — discover ingest throws
#    "Supermarket vea is inactive" otherwise). Idempotent.
npm run db:setup

# 2. Discover + INGEST for real (omit --search-only):
npx tsx --env-file=.env scripts/discover-products.ts vea
```

What real discovery does per found EAN:
1. Creates the master `products` row (deduped by EAN against existing stores).
2. Creates the `supermarket_products` row with `is_active = true`.
3. Does **NOT** capture a price immediately (`runInitialScrape: false`) — kept
   fast on purpose.

After ingest:

- The **next scheduled daily run** enqueues every active `supermarket_product`
  of every active supermarket (see `src/orchestrator/enqueue.ts`) and captures
  prices. ✅
- Want prices **now** (needs Redis):
  `npm run orchestrator:run-now -- --supermarket=vea`.

> **Worker pickup:** the worker auto-reconciles active supermarkets every ~60s
> (`RELOAD_INTERVAL_MS` in `src/worker/index.ts`), so a chain you just activated
> via `db:setup` starts getting its queue consumed within a minute — no
> `pm2 reload worker` / restart required. (Before this existed, jobs for a
> newly-activated chain would enqueue but sit unconsumed, leaving the run stuck
> "running".)

| Command | Writes to DB? | Captures price? | Use when |
| --- | --- | --- | --- |
| `discover-products --search-only <id>` | No | No | Preview coverage |
| `discover-products <id>` | Yes (rows, active) | No (next run does) | Go live |
| `scrape:url -- <url>` | Yes | Yes (immediately) | Single-URL E2E test |
| `orchestrator:run-now -- --supermarket=<id>` | Yes (snapshots) | Yes | Backfill now (needs Redis) |

---

## 6. Non-VTEX path

If the site isn't VTEX, write a full adapter. Pick the closest existing template:

| Template | Stack | Strategy |
| --- | --- | --- |
| `coto.ts` | Oracle Commerce/Endeca JSON | Append `?format=json`, parse attributes; EAN discovery via `Ntk` (see below) |
| `lacoopeencasa.ts` | JSON API behind SPA | `{ estado, mensaje, datos }` envelope |
| `atomo.ts` | PrestaShop SSR HTML | Parse `<script type="application/ld+json">` |
| `maxiconsumo.ts` | Magento 2 SSR HTML | Parse microdata + inline GA4 `dataLayer` |
| `maxi-carrefour.ts` | Custom PHP + auth | HTML fragments, Playwright self-healing cookie |

Rules of thumb:
- Implement `canonicalizeUrl` (strip all query/hash).
- Implement `resolveExternalId` if the id isn't trivially in the path.
- Throw the right `ScrapeError` type (`product_not_found`, `price_missing`,
  `auth_required`, `selector_failed`, ...) — the worker's retry policy keys off it.
- Implement `searchByEan` only if the site has a barcode search; otherwise URLs
  must be added manually (`scrape:bulk`) and the store is skipped by discovery.
- Wiring (registry, `detectSupermarket`, `setup-db`) is identical to the VTEX path.

**Non-VTEX EAN search (Coto / Endeca example)**: a site without a VTEX catalog
API can still support discovery if it exposes *any* way to query by barcode.
Coto's default keyword search (`?Ntt=<ean>`) does **not** index the EAN, but
Oracle Commerce/Endeca lets you scope a keyword query to one record property
via `Ntk`:

```
/sitios/cdigi/categoria?Ntk=product.eanPrincipal&Ntt=<ean>&Nty=1&format=json
```

`coto.ts#searchByEan` fetches that, recursively finds the record whose
`product.eanPrincipal` exactly matches the EAN (so it ignores unrelated
products in recommendation carousels), and builds the canonical URL from
`record.id` — Coto resolves `/_/R-<id>` regardless of the (decorative) slug.

---

## 7. Checklist

- [ ] Adapter file created (`src/adapters/<id>.ts`)
- [ ] Registered in `registry.ts`
- [ ] Hostname routed in `detectSupermarket` (`src/ingest/index.ts`)
- [ ] Seeded + `is_active: true` in `setup-db.ts`
- [ ] `npm run typecheck` clean
- [ ] `npm run test:adapter -- <url>` returns a sane price
- [ ] `discover-products --search-only <id>` shows expected coverage
- [ ] `npm run db:setup` then `discover-products <id>` to go live
- [ ] Push to main (CI runs `db:setup` + reloads the worker automatically)
