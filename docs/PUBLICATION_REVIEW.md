# Publication & Daily Review

How we go from a **raw daily scrape** to **verified data the client can trust**,
with no gaps in the price history.

This is the design + implementation spec for the "check the day, then release
it" workflow. It covers the data model (migration `005`), the backend pipeline
changes, the new API surface, and the operator frontend.

> **Status:** backend implemented. Migration `005_publication_layer.sql`,
> finalize → `pending_review`, `src/orchestrator/publish.ts`, the four API routes,
> the `Estado` client field, and fixtures are all in place (typecheck passes).
> **Frontend (§6) is pending.** Deploy the app + run the migration together.

---

## 1. The problem

Today the client reads `client_base` (via `GET /v1/data/pricing` and
`/v1/data/export`), and that view sits directly on **every** `price_snapshots`
row. Two consequences:

1. **No review gate.** The instant a daily run finishes — even a half-broken one
   — its rows are live to the client. Nobody "checks the day" first.
2. **Gaps, not records.** A product that failed to scrape, went out of stock
   with no price, or got delisted produces **no row at all** for that day. The
   client can't distinguish "we checked and it was gone" from "we never checked".
   The history has holes.

We want: a **production layer** the client pulls from that only contains
**reviewed, verified, complete** days — every product present every day, with a
clear status when there's no price.

We do **not** need a second database. We add a publication state + a status
model to the existing schema.

---

## 2. The model (migration `005`)

Three orthogonal concepts, plus a `client_base` rewrite. All in
[`migrations/005_publication_layer.sql`](../migrations/005_publication_layer.sql).

### 2.1 Run publication lifecycle — `scrape_runs.review_status`

Separate from the existing execution `status` (`running`/`completed`/`failed`).

```
pending_review  →  published
```

- A run is **invisible to the client** until `review_status = 'published'`.
- Publishing is a single explicit operator action (manual; no auto-publish).
- New columns: `review_status` (default `pending_review`), `published_at`,
  `published_by`.
- **No backfill:** the workflow starts fresh from today. Existing runs stay
  `pending_review` (hidden from the client) until explicitly published. Run-less
  ad-hoc/manual snapshots remain visible (see §2.4). This means the client feed
  shows only days you publish from go-live onward; historical scraped days are
  not retroactively exposed unless you publish their runs.

### 2.2 Per-row outcome status — `price_snapshots.status` + nullable `price`

This is what eliminates the gaps. `status` is one of:

| `status` | Meaning | `price` | Client-visible? |
|---|---|---|---|
| `ok` | A real observed price | set | yes |
| `out_of_stock` | Confirmed out of stock | may be set (last seen) or NULL | yes |
| `not_found` | Product page 404 / gone from the site | NULL | yes |
| `delisted` | Officially removed from this chain's catalog | NULL | yes |
| `scrape_failed` | Couldn't get the price this day (transient/operational) | NULL | **no — internal only** |

`scrape_failed` is an operational state about *our* pipeline, not a real-world
fact about the product, so the client never sees it. It still lives in the DB so
the operator can audit coverage and know what to fix; the `client_base` view
filters it out (`status <> 'scrape_failed'`). The client-facing statuses all
describe the product itself.

`price` becomes **nullable** so marker rows are representable. Existing rows all
have a price, so this is backward-compatible.

**Guarantee:** when a run is published, **every active mapping has exactly one
row** for that day — a real price or a marker row. Internally the grid is always
complete (incl. `scrape_failed` markers for audit). The **client** sees every
row except `scrape_failed`, so its series is complete for all *verified* outcomes
(priced / out of stock / gone). A product left unresolved as `scrape_failed` at
publish time is simply absent from the client feed for that day — the incentive
is to resolve it during review.

### 2.3 Product lifecycle — `supermarket_products.lifecycle_status`

For products that are *officially* gone (not a one-day failure):

```
active | out_of_stock | delisted
```

Plus `lifecycle_note` and `lifecycle_changed_at`. Once flagged `delisted`/
`out_of_stock`, future runs auto-emit the matching marker row instead of
failing + alerting every single day.

### 2.4 `client_base` rewrite

Same 31-column shape, three changes:

- **Published-only:** `LEFT JOIN scrape_runs` and `WHERE r.id IS NULL OR
  r.review_status = 'published'`. Run-less snapshots (ad-hoc `scrape:url`,
  manual operator inserts) are trusted and stay visible.
- **Internal failures hidden:** `AND status <> 'scrape_failed'` — operational
  failures never reach the client.
- **New `Estado` column** exposing `price_snapshots.status` (only the
  client-facing values ever appear, since `scrape_failed` is filtered).
- **NULL-price-safe** calculated columns (`LEAST`/`GREATEST` ignore NULLs; the
  discount `CASE` folds to 0 when price is NULL).

---

## 3. The daily workflow

```
06:00   Daily scrape runs.
        → finalize sets status=completed, review_status=pending_review
        → client_base does NOT include it yet (client sees no change)

You     Open "Publicación / Daily Review" → the pending run.
        Coverage: 1,180 / 1,210 products priced. 30 gaps.
        For each gap (grouped by supermarket + error type), choose:
          • Re-run        → POST /v1/runs/:id/retry-failed     (exists)
          • Manual price  → POST /v1/snapshots/manual          (exists)
          • Out of stock  → POST /v1/runs/:id/snapshots/flag   (new) status=out_of_stock
          • Delisted/gone → POST /v1/runs/:id/snapshots/flag   (new) status=delisted | not_found
                            (delisted also sets the mapping lifecycle)

You     Click "Publicar día".
        → reconcile: any still-unresolved gap gets a scrape_failed marker row
        → review_status = published, published_at/by stamped
        → client_base now serves this day, complete, no holes
```

Most *fixing* tools already exist. What's new: the **gate**, the **status
model**, the **gap-fill on publish**, and the **review UI**.

---

## 4. Backend changes

### 4.1 Finalize → `pending_review`

[`src/orchestrator/finalize.ts`](../src/orchestrator/finalize.ts) currently flips
a finished run to `status = 'completed'`. Add: set
`review_status = 'pending_review'` at the same time (only if not already set, so
manual republishes aren't clobbered). Health/alert generation stay as-is.

### 4.2 Publish + gap reconciliation (new module)

New `src/orchestrator/publish.ts` (callable from the API route and a CLI):

```ts
// Pseudocode
async function publishRun(runId: string, publishedBy: string) {
  // 1. Find active mappings expected in this run that have NO snapshot in it.
  const gaps = await findUnresolvedGaps(runId);

  // 2. For each gap, insert ONE marker row into price_snapshots:
  //    - mapping.lifecycle_status === 'delisted'     → status='delisted'
  //    - mapping.lifecycle_status === 'out_of_stock' → status='out_of_stock'
  //    - last job_execution.error_type === 'product_not_found' → 'not_found'
  //    - otherwise                                   → 'scrape_failed'
  //    price = NULL, in_stock = false, scrape_run_id = runId, tier_used='marker'
  await insertMarkerRows(runId, gaps);

  // 3. Flip the run. Idempotent: re-publishing only fills NEW gaps.
  await markRunPublished(runId, publishedBy);
}
```

"Expected mappings" = active `supermarket_products` for the supermarkets that
participated in the run. Reconciliation is **idempotent**: a mapping that
already has any row in the run is skipped.

> A run scoped to a subset (e.g. a `retry-failed` recovery run) should publish
> against the same scope it was enqueued with — store the scope in
> `scrape_runs.metadata` at enqueue time and read it back here.

### 4.3 Lifecycle-aware enqueue (optional, phase 2)

When enqueuing the daily run, mappings already flagged `delisted`/`out_of_stock`
can skip the network call and go straight to a marker row, saving requests and
avoiding daily alerts. Until this lands, they just become `scrape_failed` gaps
that publish-time reconciliation reclassifies from the mapping lifecycle.

---

## 5. API changes

All under `/v1`, behind the existing `X-API-Key` auth. Operator-facing routes
(review, publish, flag, lifecycle) are distinct from the client-facing
`/v1/data/*`.

### 5.1 New endpoints

#### `GET /v1/runs/:id/review`
Everything the review screen needs in one call.

```json
{
  "data": {
    "run": { "id": "...", "status": "completed", "review_status": "pending_review",
             "started_at": "...", "finished_at": "...", "total_jobs": 1210 },
    "coverage": {
      "expected": 1210, "priced": 1180, "markers": 0, "gaps": 30,
      "coveragePct": 97.5
    },
    "bySupermarket": [
      { "supermarket_id": "carrefour", "expected": 100, "priced": 92,
        "gaps": 8, "topErrors": [{ "type": "selector_failed", "count": 6 }] }
    ],
    "gaps": [
      { "supermarket_product_id": "...", "supermarket_id": "carrefour",
        "ean": "...", "name": "...", "external_url": "...",
        "error_type": "selector_failed", "error_message": "...",
        "lifecycle_status": "active", "last_known_price": 2599.0 }
    ]
  },
  "meta": { "ts": "..." }
}
```

#### `POST /v1/runs/:id/publish`
Reconcile gaps → flip to `published`.

```json
// Request
{ "force": true }            // optional; publish even with unresolved gaps
// Response 200
{ "data": { "run_id": "...", "review_status": "published",
            "markers_inserted": 12, "published_at": "...", "published_by": "..." },
  "meta": { "ts": "..." } }
```
If `force` is false and gaps remain, return `409 CONFLICT` with the gap count so
the UI can prompt "publish anyway?".

#### `POST /v1/runs/:id/snapshots/flag`
Write no-price marker rows for specific products in this run.

```json
// Request
{ "status": "out_of_stock",                 // out_of_stock | not_found | delisted
  "supermarket_product_ids": ["...", "..."],
  "note": "Confirmed OOS on site",
  "set_lifecycle": true }                    // when status=delisted/out_of_stock,
                                             // also set the mapping lifecycle
// Response 200
{ "data": { "inserted": 2, "lifecycle_updated": 2 }, "meta": { "ts": "..." } }
```

#### `PATCH /v1/supermarket-products/:id/lifecycle`
Set a product's lifecycle independent of any run.

```json
{ "lifecycle_status": "delisted", "note": "Discontinued by Carrefour" }
```

### 5.2 Reused endpoints (no change)

- `GET /v1/runs`, `GET /v1/runs/:id`, `GET /v1/runs/:id/progress`,
  `GET /v1/runs/:id/failures` — now also return `review_status`.
- `POST /v1/runs/:id/retry-failed` — re-run gaps.
- `POST /v1/snapshots/manual` — operator-entered prices (`tier_used: "manual"`).
- `GET /v1/data/coverage` — EAN coverage per chain.

### 5.3 Client contract change — `Estado`

[`src/api/lib/clientPricing.ts`](../src/api/lib/clientPricing.ts): add `Estado`
to `PriceDataItem`, mapped from the view's `Estado` column. Document in
[`CLIENT_DATA_API.md`](./CLIENT_DATA_API.md) and
[`API_PRICING_CLIENTE.md`](./API_PRICING_CLIENTE.md) that:

- The feed only ever returns **published** days.
- A row may now have an empty `Precio_Regular` with `Estado` explaining why.

Update the matching `examples/api/*.json` fixtures in the same change.

---

## 6. Frontend changes

A new **operator** area (separate from the client-facing dashboard). The
client-facing views don't change behaviorally — they just start reading only
published, complete data.

### 6.1 "Publicación / Daily Review" list
- Table of recent runs with a `review_status` badge
  (`pending_review` = amber, `published` = green), coverage %, gap count,
  `published_at`.
- Built on `GET /v1/runs` + per-row `GET /v1/runs/:id/review` (or a lightweight
  summary). Row click → review screen.

### 6.2 Run review screen (the core)
- **Coverage header:** big "1,180 / 1,210 (97.5%)" + per-supermarket breakdown
  bars (reuse `runs/:id` breakdown + `coverage`).
- **Gap table:** one row per gap (supermarket, product, EAN, error, last known
  price, lifecycle). Per-row actions:
  - **Re-run** → `retry-failed` for that product, then poll `runs/:id/progress`.
  - **Enter price** → modal → `snapshots/manual`.
  - **Out of stock** / **Delisted** / **Gone (404)** → `snapshots/flag`.
- **Sticky "Publicar día" button:** disabled until every gap is resolved or
  explicitly acknowledged. Confirm modal when forcing
  ("12 gaps will be marked `scrape_failed` — publish anyway?") → `publish`
  with `force: true`.
- After publish: badge flips to green, screen becomes read-only.

### 6.3 Product lifecycle control
- On a product/mapping detail, a "Marcar como discontinuado / sin stock" action
  → `PATCH /v1/supermarket-products/:id/lifecycle`.

### 6.4 Suggested API client additions
```ts
getRunReview: (id) => request(`/runs/${id}/review`),
publishRun:   (id, force = false) =>
  request(`/runs/${id}/publish`, { method: 'POST', body: JSON.stringify({ force }) }),
flagSnapshots: (runId, body) =>
  request(`/runs/${runId}/snapshots/flag`, { method: 'POST', body: JSON.stringify(body) }),
setLifecycle: (smpId, body) =>
  request(`/supermarket-products/${smpId}/lifecycle`, { method: 'PATCH', body: JSON.stringify(body) }),
```

---

## 7. Rollout & safety

1. **Ship migration `005` together with the backend publish code.** The
   migration alone leaves new runs in `pending_review` with no way to publish →
   the client would get no new data.
2. **No backfill.** Existing runs stay `pending_review`, so `client_base` will
   return only run-less snapshots + days you publish from go-live onward. Expect
   the client feed to be (near) empty until the first day is published — this is
   intentional. If you ever want to expose a past day, publish its run.
3. **`price` nullable** is backward-compatible. The only NULL-sensitive spots in
   `client_base` are already guarded; double-check any *other* consumer of
   `price_snapshots.price` (alerts, compare) tolerates NULL or filters
   `status = 'ok'`.
4. **Idempotency:** the migration is safe to re-run; `publishRun` only fills new
   gaps; `flag`/`lifecycle` are upserts.
5. **Order of operations matters once:** deploy migration → deploy backend →
   first daily run finalizes to `pending_review` → operator publishes.

---

## 8. Open questions

| # | Question | Default |
|---|---|---|
| 1 | Should `delisted` products be skipped at enqueue (§4.3) or only reconciled at publish? | Publish-time reconciliation first; enqueue-skip later |
| 2 | Recovery runs (`retry-failed`) — publish independently, or fold their snapshots into the parent day's published view? | Fold into parent day (retry snapshots share the original `Fecha_Relevamiento`) |
| 3 | Auto-publish a day if coverage ≥ N% after M hours, to avoid a stuck pipeline if nobody reviews? | Manual only for now; add a "stale pending_review" Telegram nudge |
| 4 | Should `out_of_stock` carry the last seen price or NULL? | NULL by default; operator can enter a manual price if useful |
