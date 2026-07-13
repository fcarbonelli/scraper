# Revistas — Debug / Analyze view (frontend spec)

> Companion to [`REVISTA_REVIEW.md`](./REVISTA_REVIEW.md). That doc describes the
> **approval modal** (the operator confirms the handful of products the AI
> auto-matched). **This** doc describes a second, read-mostly **"Revistas" debug
> view** whose job is: _"show me every magazine we've ever detected, let me open
> one, see the actual pages, and see exactly what the AI read and why it did or
> didn't match."_
>
> Build this when the approval modal shows "nothing to review" but you suspect
> the pipeline _is_ running — it almost always is; the issue is that our catalog
> (cleaning/home-care, ~370 products) only intersects a few items in a general
> wholesale flyer, so `matched` is small. This view makes that visible instead of
> looking like "it's broken".

---

## Why this view exists (what we learned)

The pipeline runs daily and **detection works** — it finds every chain's current
PDF/flipbook. Vision reads them fine too (e.g. a Makro flyer yields 157 products
across 16 pages). The gap is:

1. **Matching is naturally low.** Our catalog is cleaning/home-care only, so a
   grocery-heavy flyer legitimately matches just a few items (`3/157`, `5/80`,
   sometimes `0/38`).
2. **Old builds only stored matched pages/items.** So a magazine with `0`
   matches had **no images and no rows** → the frontend had literally nothing to
   render, which looked like "no PDF arrived".

The backend now stores **all page images** and a **full per-product analysis**
(matched or not) for every magazine, exposed via two endpoints below. The debug
view surfaces them.

---

## Endpoints (already live in the API)

Auth: `X-API-Key` like everything else. Base: `/v1`.

### 1. List every magazine — `GET /v1/revistas`

Unlike `GET /v1/revistas/pending` (only `in_review`), this returns **all**
magazines in any status. Use it for the list/table.

Query params (all optional):

| Param | Values | Notes |
|---|---|---|
| `status` | `processing` \| `in_review` \| `reviewed` | `processing` = still running, or **crashed mid-run** (worth surfacing). |
| `supermarket_id` | e.g. `makro` | One chain only. |

Response: `success(MagazineHeader[])`, newest first.

```ts
interface MagazineHeader {
  id: string;
  supermarket_id: string;
  supermarket_name: string;
  label: string;                 // e.g. "jul2mm.pdf"
  scrape_run_id: string | null;
  source_strategy: 'html-pdf-links' | 'pubhtml5' | 'publuu';
  source_url: string;            // link straight to the real PDF/flipbook
  page_count: number;
  status: 'processing' | 'in_review' | 'reviewed';
  counts: { total: number; pending: number; approved: number; rejected: number };
  detected_at: string;           // ISO
}
```

### 2. Analyze one magazine — `GET /v1/revistas/:magazineId/analysis`

The heart of the view: the **whole** magazine as the AI saw it.

```ts
interface RevistaAnalysis {
  magazine: MagazineHeader;
  page_images: { page: number; url: string }[];   // ALL pages, sorted, public Supabase URLs
  extracted_total: number;                          // products the AI read
  matched_total: number;                            // of those, auto-matched
  analysis: AnalysisItem[];
}

interface AnalysisItem {
  page: number;
  extracted: {
    name: string;
    brand: string | null;
    ean: string | null;
    price: number | null;
    promo_price: number | null;
    promo_text: string | null;
    quantity: string | null;
  };
  matched: boolean;
  method: 'ean' | 'llm' | 'manual';
  confidence: number;                 // 0..1
  reason: string;                     // judge's explanation (why matched / not)
  matched_product_id: string | null;
  top_candidates: { id: string; name: string | null; brand: string | null }[]; // up to 3
}
```

---

## Screen 1 — Revistas list

A table/page (e.g. under the Daily Review area, or its own nav item "Revistas").

- **Data:** `GET /v1/revistas` (optionally default filter `status=in_review`, with
  a toggle to show all).
- **Columns:** chain (`supermarket_name`), `label`, `status` badge, `page_count`,
  `counts.total` (matched items queued), `detected_at`, and a derived
  "extracted" count is _not_ in this payload — show `counts.total` here and the
  full extracted/matched numbers on the detail screen.
- **Status badges:**
  - `processing` → amber "Procesando / revisar" (if it's been >1h it likely
    **crashed** — flag it; a re-run fixes it).
  - `in_review` → blue "Para revisar".
  - `reviewed` → green "Revisada".
- **Row click →** Screen 2.
- Empty state: if the list is empty, the pipeline has genuinely never produced a
  row — that's a backend/deploy problem, not a frontend one (see the ops note).

## Screen 2 — Analyze a magazine

Two-pane layout. **Left: pages. Right: what the AI read.**

- **Data:** `GET /v1/revistas/:id/analysis`.
- **Header:** magazine label, chain, status, `matched_total / extracted_total`
  (e.g. "8 de 237 productos con match"), `source_url` link (open the real PDF).
- **Left pane — page viewer:** a vertical scroll or carousel of `page_images`
  (`<img src={url}>`). This is the "see the actual PDF" the operator wanted.
  Clicking a product on the right should scroll/highlight its `page`.
- **Right pane — extracted products:** render `analysis` grouped by `page`.
  For each `AnalysisItem` show:
  - `extracted.name` + `brand` + `quantity`, and price/promo.
  - A **match chip**: green "Match ✓" when `matched`, grey "Sin match" otherwise,
    with the `confidence` (as %) and the `reason` in a tooltip/expandable.
  - When matched: the matched product (`matched_product_id`) — link into the
    normal product page.
  - When not matched: list `top_candidates` (nearest catalog products) so the
    operator can eyeball whether a real match was missed.
- **Filter toggle:** "Solo con match" / "Todos". Default to "Todos" here (the
  whole point is to see everything).

### Optional: rescue an unmatched item from this view

The approval modal (`REVISTA_REVIEW.md`) only lists auto-matched items. If an
operator spots a real product in the "Sin match" list here, they can add it with
the existing endpoint — no new backend needed:

```
POST /v1/revistas/:magazineId/items
{ "page_number": 5, "product_id": "<catalog uuid>", "price": 1234.5,
  "promo_price": 999, "promo_text": "2x1", "reviewed_by": "ana" }
```

`product_id` must be an existing **catalog** product. This creates an `approved`,
`method:"manual"` item + a `supermarket_products` mapping + a `price_snapshots`
row (publishes through the normal gate). A product picker (search the catalog)
feeds `product_id`.

---

## How to read the analysis (for the operator / us)

- **`matched_total` small but `extracted_total` large** → expected. The catalog
  is cleaning-only; grocery items simply have no counterpart. Not a bug.
- **`matched` false with a clearly-correct `top_candidate`** → matcher/threshold
  tuning issue worth reporting (the `reason` says why the judge rejected it).
- **`extracted_total` = 0** → vision failed for that magazine (rare; check the
  source PDF opens).
- **status stuck `processing`** → the run crashed; a `revistas:run --force`
  re-run (or the next daily run) reprocesses it.

---

## Ops note (backend, not frontend)

If the list is empty in production, it's not the UI:

- Confirm the revista code is **deployed** and `npm run db:setup` ran (seeds the
  4 chains with `config.source_type='revista'`).
- Run **`npm run revistas:doctor`** on the server — it prints, with **no AI
  cost**, whether chains are configured, whether discovery finds the current
  issues, and the status of every stored magazine.
- To (re)populate everything now: **`npm run revistas:run -- --force`** — this
  reprocesses all currently-published issues, uploads all page images, and stores
  the analysis. Costs vision tokens; run it deliberately.
