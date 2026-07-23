# Revista (Magazine) Review — Frontend Guide

How the operator reviews products that the system reads from a supermarket's
**weekly/bi‑weekly promo magazine** (a PDF or online "flipbook") and approves
them into the price data, from inside the existing **Daily Review** screen.

This is the spec for the **review modal** and the API it consumes. It mirrors the
shape of [`PUBLICATION_REVIEW.md`](./PUBLICATION_REVIEW.md) and
[`FRONTEND_OPERATIONS_GUIDE.md`](../FRONTEND_OPERATIONS_GUIDE.md).

> **Status:** implemented. The backend pipeline (`src/revistas/`) and the
> `/v1/revistas/*` endpoints below are live, with fixtures in
> [`examples/api/`](../examples/api/) (`revistas-pending.json`,
> `revista-items.json`, `revista-approve.json`). This file is the source of
> truth for the contract and is kept in sync with the routes.
>
> **Chains (seeded):** Makro & Vital (`html-pdf-links`), Rosental (`pubhtml5`),
> Maxicomodín (`publuu`). Maxicomodín is seeded as a **separate** chain from the
> retail `comodin` VTEX store on purpose — the magazine is the wholesale
> (mayorista) pricing tier, which the retail adapter deliberately doesn't track.

---

## 1. Why this exists

Most supermarkets are scraped by **product URL** (HTML/API) — see the rest of the
platform. But a few chains **don't publish their promos on the web**: they only
publish them in a **magazine** (a PDF or an online flipbook). The prices and
products live *inside images*, so there's nothing to scrape as HTML.

We close that gap with AI:

1. The daily run **checks whether the magazine changed** (cheap hash/size check).
   Magazines update every 1–2 weeks, so on most days this is a no‑op.
2. When a **new issue** is detected, the system **reads every page with vision
   AI**, extracts the products (name, brand, price, promo, quantity, EAN), and
   **matches each one against our product catalog** with a confidence score.
3. The matches land in a **human review queue**. **Nothing reaches the client
   until a person approves it** — exactly like the daily publish gate, because
   the AI both *reads* and *guesses the match* and can be wrong.

The reviewer's job: confirm or fix what the AI found, page by page.

**Chains using this path (initial):** Makro, Vital, Rosental, Comodín.

---

## 2. Where it lives in the UI

Inside the existing **"Publicación / Daily Review"** area (the same screen where
you review gaps and publish the day).

- When the system finds a **new magazine awaiting review**, show a **modal /
  banner**: *"Se encontró una nueva revista de **{Cadena}** para revisar
  ({N} productos)."* with a **"Revisar"** CTA.
- The same signal also appears as an **alert** (`type: "revista_review"`), so it
  shows up in the alert inbox and fires a Telegram ping. Either can drive the
  badge; the canonical source for the modal is `GET /v1/revistas/pending`.
- **`GET /v1/revistas/pending` only returns magazines that actually have
  something to review** (status `in_review` **and** ≥1 pending item). Magazines
  where the AI matched nothing — the common case, since most folletos are
  grocery items and our catalog is cleaning-focused — do **not** raise the
  banner (they'd give the operator an empty queue). They stay inspectable in the
  full list (`GET /v1/revistas`) and the analysis view. So: **no banner ⇒
  nothing to approve**, not "the feature is broken."
- Reviewing a magazine is **independent of publishing the day** — a pending
  magazine does **not** block `POST /v1/runs/:id/publish`. When you approve an
  item, its price snapshot is written **run-less** (`scrape_run_id = null`):
  operator-trusted and **immediately client-visible**, exactly like a manual
  snapshot. It does **not** wait for any daily run to be published.
- **Daily check visibility.** Most days no magazine changes, so nothing is
  created — which used to look like "the check isn't running". Every daily probe
  now writes a row per chain to a **check log** (`GET /v1/revistas/checks`), so
  the operator can always see *"Makro — checked 12:00, sin cambios"*. Show this
  as a small "Revistas — últimos chequeos" panel (see §6a). `?latest=true` gives
  one row per chain for a compact "last checked" view.

```
06:00  Daily run. Magazine unchanged → nothing happens.
       Magazine changed → AI reads it, builds the review queue,
       creates a `revista_review` alert + a pending entry.

You    Open Daily Review → modal "nueva revista de Makro (8 productos)".
       Click "Revisar".
       For each item: see the page image + extracted product + proposed match.
         • APROBAR              → product added to that super @ the magazine price
         • APROBAR (otro match) → pick the correct catalog product, then approve
         • DESAPROBAR           → discard (not a real/relevant product)
         • + Agregar producto   → AI missed one you can see → pick product + price
       Finish → magazine marked reviewed, drops out of "pending".

       Approved prices are already live in the client export (run-less), and a
       daily carry-forward re-emits them every day until the next issue.
```

---

## 3. The review modal (the core screen)

A two‑pane, one‑item‑at‑a‑time reviewer (optimized for speed):

- **Left pane — the evidence.** The **page image** the product was read from
  (`page_image_url`, a public Supabase Storage URL — drop straight into `<img>`).
  Allow zoom/pan; highlight the page number. This is what the reviewer checks the
  proposed match against.
- **Right pane — the decision.**
  - **Extracted** (what the AI read from the page): name, brand, quantity, EAN,
    `price`, `promo_price`, `promo_text`.
  - **Proposed match** (the catalog product the AI thinks it is): name, brand,
    EAN, plus a **confidence bar** and the judge's one‑line **reason**. May be
    `null` when the AI found no match (those items aren't queued by default — see
    §6 "no‑match" handling).
  - **Price fields** (editable): pre‑filled from what the AI read, so the
    reviewer can correct an obvious vision misread before approving.
  - **Actions:** `APROBAR` · `DESAPROBAR` · `Elegir otro producto` ·
    `+ Agregar producto manual`.
- **Header:** chain name, magazine label, progress (`12 / 47 revisados`), and a
  filter (pending / approved / rejected).
- **Keyboard shortcuts** (match the original tool): **A** = aprobar,
  **R** = desaprobar, **←/→** = prev/next item.

### The three decisions

1. **APROBAR** — the proposed match is correct. → `POST /items/:id/approve`
   (no `product_id` → uses the proposed match). The product is added to that
   supermarket (a `supermarket_products` row) and a **price snapshot** is written
   at the magazine price (`tier_used: "ai"`).
2. **Wrong match → "Elegir otro producto"** — the AI read a real product but
   matched the wrong catalog item. Open the **product picker** (typeahead on
   `GET /v1/products?search=`), pick the correct one, then approve →
   `POST /items/:id/approve` **with** `product_id`.
3. **DESAPROBAR** — the extracted item isn't a real/relevant product (decoration,
   misread, or a product we don't track). → `POST /items/:id/reject`. Nothing is
   written.

### Adding a product the AI missed

If the reviewer sees a product on the page that isn't in the queue (the AI didn't
extract it, or extracted it with no match): **"+ Agregar producto manual"** →
product picker (catalog only) + price fields read off the image →
`POST /v1/revistas/:magazineId/items`. This writes the mapping + snapshot
directly (recorded with `method: "manual"`).

> **Catalog‑only.** Per decision, the picker only links to **existing master
> products** (the client's tracked EANs). There is no "create a brand‑new master
> product" flow here — if a magazine product isn't in the catalog, it's out of
> scope and should be left unmatched / rejected.

---

## 4. API surface (proposed)

All under `/v1`, behind the existing `X-API-Key` auth, using the standard
envelope (`{ data, pagination?, meta }`). Operator‑facing, like the other
`/v1/runs/*` review routes.

### `GET /v1/revistas/pending`

Drives the modal/badge. Magazines with unreviewed items.

```json
{
  "data": [
    {
      "id": "mag_01H...",
      "supermarket_id": "makro",
      "supermarket_name": "Makro",
      "label": "Makro Ofertas 2da quincena Junio",
      "scrape_run_id": "...",
      "page_count": 57,
      "status": "in_review",
      "counts": { "total": 8, "pending": 8, "approved": 0, "rejected": 0 },
      "detected_at": "2026-06-29T09:05:00.000Z",
      "series_key": "mm",
      "superseded_by": null,
      "superseded_at": null
    }
  ],
  "meta": { "ts": "..." }
}
```

`series_key` (e.g. `"mm"`, `"folder-resto"`, `"default"`) scopes supersede /
carry-forward when a chain publishes several concurrent flyer series.

### `GET /v1/revistas/:magazineId`

Single magazine header + counts (same fields as a `pending` item).

### `GET /v1/revistas/:magazineId/items`

The review queue. Paginated.

| Param | Type | Description |
|---|---|---|
| `page`, `limit` | int | Pagination |
| `status` | `pending` \| `approved` \| `rejected` | Filter |
| `page_number` | int | Only items read from a given magazine page |

```json
{
  "data": [
    {
      "id": "item_01H...",
      "magazine_id": "mag_01H...",
      "supermarket_id": "makro",
      "page_number": 16,
      "page_image_url": "https://<project>.supabase.co/storage/v1/object/public/revista-pages/makro/mag_01H/page-16.png",
      "extracted": {
        "name": "Lavandina Ayudín 1L",
        "brand": "Ayudín",
        "ean": null,
        "price": 1299.0,
        "promo_price": 999.0,
        "promo_text": "2do al 50%",
        "quantity": "1L"
      },
      "proposed_match": {
        "product_id": "50bb31b8-...",
        "name": "Lavandina Original Ayudin 2l",
        "brand": "AYUDIN",
        "ean": "7793253006709",
        "quantity": "2 Litro"
      },
      "confidence": 0.82,
      "method": "llm",
      "reason": "Misma marca y tipo (lavandina original); difiere el tamaño.",
      "candidates": [
        { "product_id": "50bb31b8-...", "name": "Lavandina Original Ayudin 2l", "brand": "AYUDIN" }
      ],
      "status": "pending",
      "reviewed_by": null,
      "reviewed_at": null
    }
  ],
  "pagination": { "page": 1, "limit": 50, "total": 8, "totalPages": 1 },
  "meta": { "ts": "..." }
}
```

`method`: `"ean"` (exact barcode), `"llm"` (semantic + judge), `"manual"`
(reviewer‑added). `confidence` is `0`–`1` (render as a colored bar; `1.0` for
EAN matches).

### `POST /v1/revistas/items/:itemId/approve`

Approve a queued item. Writes a `supermarket_products` mapping (if missing) +
one **run-less** `price_snapshots` row (`tier_used: "ai"`, `status: "ok"`,
`scrape_run_id: null`). Run-less = operator-trusted and always client-visible,
so the approved price shows in the export immediately (no publish step needed).

```jsonc
// Body — all optional; omit to accept the AI's values as-is.
{
  "product_id": "uuid",      // override the proposed match with the correct catalog product
  "price": 1299.0,           // regular price the reviewer confirms off the image
  "promo_price": 999.0,      // sale/offer price, if any
  "promo_text": "2do al 50%",
  "note": "string"
}
```

```json
// Response 200
{
  "data": {
    "item_id": "item_01H...",
    "status": "approved",
    "supermarket_product_id": "uuid",
    "snapshot_id": 10231,
    "product_id": "50bb31b8-..."
  },
  "meta": { "ts": "..." }
}
```

Errors: `400 INVALID_REQUEST` (e.g. approving with neither a proposed match nor a
`product_id`), `404 NOT_FOUND`, `409 CONFLICT` (already reviewed).

### `POST /v1/revistas/items/:itemId/reject`

```json
// Body
{ "note": "no es un producto / mal leído" }   // optional
// Response 200
{ "data": { "item_id": "item_01H...", "status": "rejected" }, "meta": { "ts": "..." } }
```

### `GET /v1/revistas/items`

Cross-magazine review-item list (powers `/revistas/aprobados` and the control
Excel). Register **before** `/:magazineId`. Query: `page`, `limit`, `status`,
`supermarket_id`, `search`, **`current_only`** (default `true` — only items on
magazines with `superseded_by IS NULL`; pass `current_only=false` for history).
Each row is a normal review item **plus** `supermarket_name`, `magazine_label`,
`source_url`, `magazine_status`, `series_key`, `superseded_by`. `extracted`
returns the **effective** prices (operator `approved_override` beats the AI
read). See `examples/api/revista-items-all.json`.

### `PATCH /v1/revistas/items/:itemId`

Edit an **approved** item. Body (all optional; ≥1 required): `product_id`,
`price`, `promo_price` (null clears), `promo_text` (null/`""` clears), `note`,
`reviewed_by`. Corrections go into `approved_override` (AI `extracted` is
preserved). The snapshot for **today** is updated in-place (never a second
row). Rematch (`product_id` changed) = undo old mapping effects + re-approve.
See `examples/api/revista-update.json`. Errors: `400`, `404`, `409` (not approved).

### `DELETE /v1/revistas/items/:itemId`

Undo an approval → item returns to `pending`. Deletes the approval snapshot +
carry-forward chain (and today's revista row), pauses the mapping when no other
approved item still points at it, and reopens a `reviewed` magazine to
`in_review`. See `examples/api/revista-delete.json`.

### `GET /v1/revistas/ean-collisions`

Read-only warning list: same EAN + same chain + same day with **distinct**
`product_id`s (mis-assigned barcodes — do **not** auto-delete). Query:
`?day=YYYY-MM-DD` (default today BA), `?supermarket_id=`. See
`examples/api/revista-ean-collisions.json`.

### `GET /v1/revistas/duplicates`

Family-A warning list: same mapping + same BA day with **2+** run-less revista
snapshots. Default window = **last 3 Buenos Aires days** (does not resurface
old one-off batches). Query: `?days=N` (1–90, default 3), `?day=YYYY-MM-DD`
(exact day — mutually exclusive with `days`), `?supermarket_id=`. Each group
includes `keep` (offer wins, else newest) and `drop` (losers). See
`examples/api/revista-duplicates.json`.

### `POST /v1/revistas/duplicates/resolve`

Collapse **one** duplicate group. Body: `{ "supermarket_product_id": "uuid",
"day": "YYYY-MM-DD" }`. Applies the same keep/drop rule and deletes the losers.
Response: `{ supermarket_product_id, day, kept_snapshot_id, deleted_snapshot_ids }`.
Errors: `404` (mapping missing), `400` (not a revista mapping), `409` (no
duplicate group for that mapping/day).

### `POST /v1/revistas/:magazineId/items`

Manually add a product the AI missed. Catalog‑only `product_id`.

```jsonc
{
  "page_number": 16,         // which page it was seen on (for the image link)
  "product_id": "uuid",      // existing master product (required)
  "price": 1299.0,           // required
  "promo_price": 999.0,
  "promo_text": "2do al 50%",
  "note": "string"
}
```

Response: same shape as `approve` (creates an `approved`, `method: "manual"`
item + mapping + snapshot).

### `POST /v1/revistas/:magazineId/finalize`

Mark the magazine reviewed (drops it from `pending`, resolves the
`revista_review` alert). Optional `{ "force": true }` to finalize with items
still `pending` (they stay pending and can be revisited).

```json
{ "data": { "magazine_id": "mag_01H...", "status": "reviewed",
            "approved": 6, "rejected": 2, "pending": 0 },
  "meta": { "ts": "..." } }
```

### Reused (no change)

- `GET /v1/products?search=` — the **product picker** for "elegir otro producto"
  and "agregar manual".
- `GET /v1/runs/:id/review`, `POST /v1/runs/:id/publish` — the day's publish gate
  for the **web-scraped** chains. Magazine snapshots are run-less, so they are
  **not** part of any run's review/gap list and don't depend on it — they surface
  in the client export on their own.

---

## 5. TypeScript types

Drop‑in for the frontend (`src/types/revistas.ts`). Reuses the envelopes from
[`API.md`](../API.md).

```ts
export type RevistaMethod = 'ean' | 'llm' | 'manual';
export type RevistaItemStatus = 'pending' | 'approved' | 'rejected';
export type RevistaMagazineStatus = 'in_review' | 'reviewed';

export interface RevistaMagazine {
  id: string;
  supermarket_id: string;
  supermarket_name: string;
  label: string;
  scrape_run_id: string | null;
  page_count: number;
  status: RevistaMagazineStatus;
  counts: { total: number; pending: number; approved: number; rejected: number };
  detected_at: string; // ISO 8601 UTC
  /** Flyer series within the chain (e.g. 'mm', 'gt', 'folder-resto'). */
  series_key: string;
  /** Newer issue that replaced this one within the same series; null = still current. */
  superseded_by: string | null;
  superseded_at: string | null;
}

export interface RevistaExtracted {
  name: string;
  brand: string | null;
  ean: string | null;
  price: number | null;        // regular price the AI read
  promo_price: number | null;  // sale/offer price the AI read
  promo_text: string | null;
  quantity: string | null;
}

export interface RevistaMatch {
  product_id: string;
  name: string;
  brand: string | null;
  ean: string | null;
  quantity: string | null;
}

export interface RevistaReviewItem {
  id: string;
  magazine_id: string;
  supermarket_id: string;
  page_number: number;
  page_image_url: string;              // public URL — use directly in <img>
  extracted: RevistaExtracted;
  proposed_match: RevistaMatch | null; // null = AI found no match
  confidence: number;                  // 0–1
  method: RevistaMethod;
  reason: string;
  candidates: Array<Pick<RevistaMatch, 'product_id' | 'name' | 'brand'>>;
  status: RevistaItemStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
}

export interface RevistaApproveBody {
  product_id?: string;   // override proposed match
  price?: number;
  promo_price?: number;
  promo_text?: string;
  note?: string;
}

export interface RevistaApproveResult {
  item_id: string;
  status: RevistaItemStatus;
  supermarket_product_id: string;
  snapshot_id: number;
  product_id: string;
}
```

### Suggested API client additions

```ts
listPendingRevistas: () =>
  request<ApiSuccess<RevistaMagazine[]>>(`/revistas/pending`),
getRevista: (id: string) =>
  request<ApiSuccess<RevistaMagazine>>(`/revistas/${id}`),
listRevistaItems: (id: string, q: { status?: RevistaItemStatus; page?: number; limit?: number } = {}) =>
  request<ApiPaginated<RevistaReviewItem>>(
    `/revistas/${id}/items?${new URLSearchParams(q as Record<string, string>)}`,
  ),
approveRevistaItem: (itemId: string, body: RevistaApproveBody = {}) =>
  request<ApiSuccess<RevistaApproveResult>>(`/revistas/items/${itemId}/approve`, {
    method: 'POST', body: JSON.stringify(body),
  }),
rejectRevistaItem: (itemId: string, note?: string) =>
  request<ApiSuccess<{ item_id: string; status: RevistaItemStatus }>>(
    `/revistas/items/${itemId}/reject`, { method: 'POST', body: JSON.stringify({ note }) },
  ),
listAllRevistaItems: (q: { status?: RevistaItemStatus; supermarket_id?: string; search?: string; page?: number; limit?: number; current_only?: boolean } = {}) =>
  request<ApiPaginated<RevistaReviewItem & { supermarket_name: string; magazine_label: string; source_url?: string | null; magazine_status?: string | null; series_key?: string; superseded_by?: string | null }>>(
    `/revistas/items?${new URLSearchParams(q as Record<string, string>)}`,
  ),
updateRevistaItem: (itemId: string, body: { product_id?: string; price?: number | null; promo_price?: number | null; promo_text?: string | null; note?: string | null }) =>
  request<ApiSuccess<RevistaApproveResult>>(`/revistas/items/${itemId}`, {
    method: 'PATCH', body: JSON.stringify(body),
  }),
deleteRevistaItem: (itemId: string) =>
  request<ApiSuccess<{ item_id: string; status: 'pending'; snapshot_deleted: boolean }>>(
    `/revistas/items/${itemId}`, { method: 'DELETE' },
  ),
listEanCollisions: (q: { day?: string; supermarket_id?: string } = {}) =>
  request(`/revistas/ean-collisions?${new URLSearchParams(q as Record<string, string>)}`),
listRevistaDuplicates: (q: { days?: number; day?: string; supermarket_id?: string } = {}) =>
  request(`/revistas/duplicates?${new URLSearchParams(q as Record<string, string>)}`),
resolveRevistaDuplicate: (body: { supermarket_product_id: string; day: string }) =>
  request(`/revistas/duplicates/resolve`, {
    method: 'POST', body: JSON.stringify(body),
  }),
addRevistaItem: (magazineId: string, body: { page_number: number; product_id: string; price: number; promo_price?: number; promo_text?: string; note?: string }) =>
  request<ApiSuccess<RevistaApproveResult>>(`/revistas/${magazineId}/items`, {
    method: 'POST', body: JSON.stringify(body),
  }),
finalizeRevista: (id: string, force = false) =>
  request<ApiSuccess<{ magazine_id: string; status: RevistaMagazineStatus }>>(
    `/revistas/${id}/finalize`, { method: 'POST', body: JSON.stringify({ force }) },
  ),
listRevistaChecks: (q: { supermarket_id?: string; latest?: boolean; page?: number; limit?: number } = {}) =>
  request(`/revistas/checks?${new URLSearchParams(q as Record<string, string>)}`),
```

---

## 6a. "Revistas — últimos chequeos" panel (`GET /v1/revistas/checks`)

A small read-only panel (put it near the revista banner in the Daily Review, or
on the debug/analyze page) that answers *"is the system actually checking the
magazines?"* — because on most days nothing changes and there's nothing else to
show.

- Call `GET /v1/revistas/checks?latest=true` → a plain array with the most-recent
  check per chain. Render one row per chain:
  `{supermarket_name} · {checked_at, relative} · {outcome}` with a colored dot —
  green `new_issue`, grey `no_change`, red `error`.
- Optionally a "ver historial" link → `GET /v1/revistas/checks` (paginated) for
  the full feed (all chains, newest first), with `?supermarket_id=` to filter.
- Fields per row: `outcome` (`no_change`/`new_issue`/`error`), `candidates`
  (issues found on the site), `new_issues` (newly processed), `duration_ms`,
  `detail` (short summary / error text). See `examples/api/revista-checks.json`.
- A row with `outcome: "error"` + a timeout `detail` means that site's probe is
  failing — surface it so an operator can flag it (it does **not** affect the
  other chains or the carry-forward).

---

## 6. Behavior notes & edge cases

- **No‑match items aren't queued.** By design, the vast majority of magazine
  products aren't in our (cleaning‑focused) catalog, so the AI correctly returns
  "no match" for most. Those are **not** shown in the review queue — only proposed
  matches are. The reviewer covers genuinely‑missed products via **"+ Agregar
  producto manual"**. (If you want a "browse everything the AI read on this page"
  debug view later, the backend keeps the full extraction; not exposed for v1.)
- **Confidence is a guide, not a gate.** Even high‑confidence matches can be false
  positives (e.g. a brand whose name is a substring of another). Always show the
  page image so the human is the real filter — that's the whole point of the
  screen, not a patch over a weak model.
- **Price semantics.** The snapshot follows the platform convention used
  everywhere else: `price` = the current selling price (the promo price when
  there's an offer), `list_price` = the regular/crossed‑out price when marked
  down, and `promo_text` → `Promocion_1`. The frontend just sends what the
  reviewer confirms (`price` + optional `promo_price`/`promo_text`); the backend
  maps it onto the columns.
- **Price persistence (carry‑forward).** A regular product gets a fresh snapshot
  every day from the daily scrape, but a magazine product only gets one **when you
  approve it**. So the backend runs a daily **carry‑forward** step
  (`src/revistas/carryForward.ts`, in the orchestrator): it re‑emits each product
  **approved on the current (non‑superseded) magazine** as a fresh **run-less**
  snapshot dated today. Run-less = always client-visible, so it does **not**
  depend on any daily run being published (a day left in `pending_review` would
  otherwise hide it). That's why an approved magazine price keeps appearing in
  the daily export/compare **every day until the next revista supersedes it**.
  Revista chains are excluded from the scraper queue (they have no adapter).
  **Frontend impact: none** — the data flows through the same snapshots the
  export/compare/history already read.
  > **Supersede on new issue (per SERIES):** Makro/Vital publish several
  > concurrent flyer series (MM weekly, GT gastronomic, Folder, Nonfood, …).
  > Each magazine has a `series_key`. When the pipeline finishes ingesting
  > magazine **B**, only prior magazines **A of the same series** are marked
  > `superseded_by = B` (`superseded_at` set). Concurrent series stay current
  > and keep carrying. Carry-forward sources approvals on every current
  > (non-superseded) magazine — one per series. A's prices for that series stop
  > appearing in today's export until a human approves B's queue. Same-day:
  > today's run-less revista snapshots for mappings approved on the superseded
  > magazines of that series (and not yet on B) are purged (carry-forward runs
  > *before* discovery in the orchestrator, so A may already have been carried
  > that morning). **Mappings** whose only approvals lived on the superseded
  > magazines (and that are not also approved on another CURRENT magazine of
  > the chain) are **paused** (`is_active=false`) so `client_base` drops them
  > immediately — not only via the snapshot purge. Approving on B reactivates
  > the mapping. History on prior days is kept. Magazines expose `series_key`,
  > `superseded_by` / `superseded_at` so the UI can show "Folleto superado"
  > without date heuristics.
  > **Reliability:** carry-forward runs **first and independently** of the AI
  > magazine check in the orchestrator's daily cycle. Earlier it ran *after* the
  > check, so a slow/hung discovery (Playwright, network) could block it and make
  > magazine prices vanish the day after approval — that's fixed. The check
  > itself is now timeout-guarded and each site's probe is logged.
  > **Operational note:** carry-forward still only fires when the **orchestrator**
  > runs its daily cycle. If magazine prices stop appearing on new days, the
  > orchestrator isn't running the current build — redeploy/restart it, or run
  > `npm run revistas:run -- --carry-forward` to backfill today by hand (no AI
  > cost). After deploying pause-on-supersede, also run
  > `npm run revistas:reconcile -- --dry-run` once against prod to pause
  > leftover mappings from flyers that were already superseded before this
  > change existed; then drop `--dry-run` to apply.
- **Idempotency.** Re‑approving/rejecting an already‑reviewed item returns
  `409 CONFLICT`. Re‑running the same unchanged magazine never creates a new one
  (dedup by content hash), so the queue is stable. The carry‑forward step is
  idempotent per day (skips a product that already has a snapshot dated today).
- **One chain, many concurrent series.** A chain can publish several folletos at
  once (e.g. Makro MM + GT + Sponsor). Each becomes its own magazine row with a
  distinct `series_key`. Supersede / carry-forward are per series, so a new MM
  does not kill GT prices. Within one magazine, `page_number` and
  `page_image_url` keep pages straight.
- **Refresh cadence.** Poll `GET /v1/revistas/pending` on the same cadence as
  alerts (~30 s while the Daily Review screen is open). Items rarely change
  outside of the reviewer's own actions, so optimistic updates are fine —
  re‑fetch the item list after each action.

---

## 7. Mock‑first development

Like the rest of the API, build against fixtures first. These live in
[`examples/api/`](../examples/api/) (kept 1:1 with the real envelopes):

- `revistas-pending.json` — one in‑review magazine.
- `revista-items.json` — a paginated queue with an `ean` match, an `llm` match
  (with `candidates`), and a low‑confidence item.
- `revista-approve.json` — an approve result.

Point the API client at them exactly as described in `API.md` §"Frontend
developer setup".

---

## 8. Open questions

| # | Question | Working assumption |
|---|---|---|
| 1 | Should the reviewer be able to edit the **EAN** when approving (to backfill a missing barcode on the master product)? | No for v1 — link to catalog by `product_id` only. |
| 2 | Do we need a "browse all extracted products on a page" view (incl. no‑match), or is "+ Agregar manual" enough? | "+ Agregar manual" is enough for v1. |
| 3 | Should approving the **same product twice** in one magazine (two folletos) merge into one snapshot or keep both? | Keep the latest; backend dedups by (super, product, run). |
| 4 | Stale magazine left unreviewed for N days — Telegram nudge like the publish gate? | Add a "pending revista" nudge later; manual for now. |
