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
- Reviewing a magazine is **independent of publishing the day** — a pending
  magazine does **not** block `POST /v1/runs/:id/publish`. Approved magazine
  products simply become snapshots on the current day's run and publish with it.

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

You    Publish the day as usual. Approved magazine prices are included.
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
      "detected_at": "2026-06-29T09:05:00.000Z"
    }
  ],
  "meta": { "ts": "..." }
}
```

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
one `price_snapshots` row (`tier_used: "ai"`, `status: "ok"`) tied to the
magazine's `scrape_run_id`.

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
- `GET /v1/runs/:id/review`, `POST /v1/runs/:id/publish` — the day's publish gate;
  approved magazine snapshots are included automatically.

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
addRevistaItem: (magazineId: string, body: { page_number: number; product_id: string; price: number; promo_price?: number; promo_text?: string; note?: string }) =>
  request<ApiSuccess<RevistaApproveResult>>(`/revistas/${magazineId}/items`, {
    method: 'POST', body: JSON.stringify(body),
  }),
finalizeRevista: (id: string, force = false) =>
  request<ApiSuccess<{ magazine_id: string; status: RevistaMagazineStatus }>>(
    `/revistas/${id}/finalize`, { method: 'POST', body: JSON.stringify({ force }) },
  ),
```

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
  (`src/revistas/carryForward.ts`, in the orchestrator): it re‑emits each active
  magazine product's **latest approved price** as a fresh snapshot dated today,
  tied to the day's run. That's why an approved magazine price keeps appearing in
  the daily export/compare **every day until the next revista supersedes it**
  (policy: carry the latest price forward until a newer approval replaces it).
  Revista chains are excluded from the scraper queue (they have no adapter).
  **Frontend impact: none** — the data flows through the same snapshots the
  export/compare/history already read. Just be aware magazine chains now appear in
  the daily run every day (persisted prices), which is intended.
- **Idempotency.** Re‑approving/rejecting an already‑reviewed item returns
  `409 CONFLICT`. Re‑running the same unchanged magazine never creates a new one
  (dedup by content hash), so the queue is stable. The carry‑forward step is
  idempotent per day (skips a product that already has a snapshot dated today).
- **One magazine, many pages.** A chain can publish several folletos at once
  (e.g. Makro had 5). They're grouped under one magazine entry; `page_number` and
  `page_image_url` keep them straight.
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
