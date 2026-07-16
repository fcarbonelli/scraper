# In-store price entry — frontend build spec

This is the complete specification for the **in-store manual price-entry** tool: a
mobile-web app where a field worker, physically inside a (mostly wholesale) store,
**scans a product barcode and types the price**. It's meant for high-volume
sessions — a worker checks a few hundred products per visit — and must feel like
"open, type your name, pick where you are, and just scan."

The backend is **already implemented** (`src/instore/`, routes at `/v1/in-store/*`).
This doc is the contract + UX brief the frontend is built against. API details are
mirrored in [`API.md`](../API.md) → *In-store (manual price entry)*, with JSON
fixtures in [`examples/api/`](../examples/api/) (`in-store-*.json`).

> **Changed in this revision (client review):** work is now organized around a
> **visit (PDV relevamiento)** that carries the **branch location**; each product
> has **four capture fields**; workers can **upload flyer photos**; and there's an
> explicit **"finish visit"** to save and leave a PDV. See §3 and §4.

---

## 1. Concept & data model (what the backend guarantees)

- A submission is **trusted**: the person on-site is the gate. Each writes a
  **run-less** price snapshot that is **immediately visible** in the client export
  (no daily "publish" step).
- Prices are entered only **every few days** (≈twice a week). The backend runs a
  **daily carry-forward** that re-emits each product's latest in-store price as a
  fresh row dated today — so a Monday price keeps exporting every day until the
  next visit supersedes it. **The frontend does nothing for this.**
- The worker **never picks a date.** The server stamps every entry with the current
  time. There is no date field anywhere in the UI.
- A **visit** groups the work: one worker at one **store branch** on one occasion.
  It holds the branch **location** (address / locality / province — a chain has
  many branches) and owns the product entries and flyer photos taken there.

---

## 2. Authentication (important — no per-user logins)

- The app embeds **one API key**, sent as the `X-API-Key` header on every request.
  Field workers never receive or type a key.
- That key is **scoped to `in-store`**: it can reach **only** `/v1/in-store/*`. Any
  other endpoint returns `403 FORBIDDEN`. So a leaked app key can't touch the rest
  of the API. (Backoffice mints it with
  `npm run apikey:create -- instore-app --scope=in-store`.)
- **Attribution is by name, not by account.** On first open, the app asks for the
  worker's name, stores it in `localStorage`, and it becomes the visit's
  `entered_by` (inherited by every entry/photo in that visit).

Config the frontend needs:

```
VITE_API_BASE_URL     e.g. https://api.megaanalytics.com/v1
VITE_INSTORE_API_KEY  the in-store-scoped key
```

---

## 3. Session & visit model (set once, then just scan)

Two pieces persist in `localStorage` and are **not** re-prompted on reload:

| State | Behavior |
|---|---|
| **Worker name** | Prompted once on first open. Shown as a small, editable label in the header (tap to correct). Becomes each visit's `entered_by`. |
| **Active visit** | The current PDV relevamiento (its `id`, store, and location). Persist it so a locked phone / reload resumes the same visit. Cleared when the worker **finishes** the visit. |

Lifecycle:

```
first run: enter name ─┐
                       ▼
   ┌──────────► start visit (pick store + type location) ──► POST /visits
   │                    │
   │                    ▼
   │            scan loop (4 fields per product) ──► POST /entries { visit_id }
   │            upload flyer photos          ──────► POST /visits/:id/photos
   │                    │
   │                    ▼
   └──────────  finish visit (save & exit)  ──────► POST /visits/:id/finish
```

A worker can lock their phone mid-visit and come back — same visit, same store,
same name, ready to scan. When they're done at a store they **finish the visit**
and are taken back to "start a new visit" for the next PDV.

---

## 4. Screens & flow

### 4.1 First-run / setup
Ask for the worker's **name** (required) → save to `localStorage`.

### 4.2 Start a visit (PDV)
1. **Store dropdown** from `GET /v1/in-store/supermarkets` (data-driven — never
   hardcode; currently Nini, Diarco, Makro, Vital, Yaguar, Maxiconsumo, Don
   Gastón, Oscar David).
2. **Branch location** fields: **Provincia**, **Localidad**, **Dirección**. These
   describe the specific PDV (a chain has many branches). Recommended: not strictly
   required by the API, but strongly encourage filling them — the client needs the
   location per PDV. Persist the last-used values per store to prepopulate.
3. **Empezar relevamiento** → `POST /v1/in-store/visits` → keep the returned
   `visit.id` as the active visit → go to the scan screen.

### 4.3 Scan screen (the main loop)
Optimize for hundreds of quick entries: **scan → confirm → type prices → submit →
back to scanner**, minimal taps.

1. **Live camera** is always on (after each submit it returns straight to the
   scanner — no "start scanning" tap).
2. On a decoded barcode: immediate feedback (haptic `navigator.vibrate(50)` + short
   beep), auto-fill the EAN, call `GET /v1/in-store/lookup?ean=`.
3. **If found** → show the product **name/brand + image** (`image_url`, show a
   placeholder when null) so they confirm the item, and focus the first price field.
4. **Four capture fields** (this is the client's spec):

   | Field | Input | Required | Sends as |
   |---|---|---|---|
   | **Precio Regular (unitario)** | numeric `inputmode="decimal"` | yes | `price` |
   | **Precio con oferta (precio mayorista)** | numeric | no | `wholesale_price` |
   | **Promoción** — a partir de cuántas unidades es el precio mayorista | numeric `inputmode="numeric"` | no | `wholesale_min_units` |
   | **Observaciones** | short text | no | `note` |

   Keep the default path fast: **Precio Regular** is the only required field; the
   other three are optional (the wholesale price + min-units usually travel
   together). `POST /v1/in-store/entries` with `{ visit_id, ean, price,
   wholesale_price?, wholesale_min_units?, note? }`.
5. On success: toast `✓ Guardado (#N)`, bump the counter, return to live scanner.
6. **If not found** (`found: false`) → `No está en el catálogo` + one-tap **Omitir**.

Header (persistent): store + location chip · worker name · counter
(`N cargados en este PDV`).

### 4.4 Flyer / offer photos
Instead of marking each product's promo, workers photograph the store's
folletos/ofertas. Provide an **"Agregar foto"** action (camera or gallery) that
uploads to the **active visit**:

```js
await fetch(`${BASE}/in-store/visits/${visitId}/photos?caption=${encodeURIComponent(caption ?? '')}`, {
  method: 'POST',
  headers: { 'X-API-Key': KEY, 'Content-Type': file.type }, // raw bytes, NOT multipart/JSON
  body: file, // the File/Blob straight from <input type="file" accept="image/*" capture="environment">
});
```

Show a small thumbnail strip of the visit's photos (`GET /v1/in-store/visits/:id/
photos`). PNG/JPEG/WebP/GIF up to 15 MB.

### 4.5 Today's list
A collapsible list of everything uploaded **in the active visit** (or today for the
store) from `GET /v1/in-store/entries?visit_id=` (or default = today). Each row:
product name, regular price, wholesale price + min-units (if any), observations,
time. Lets the worker spot/fix a mistake (re-submitting is just another `POST`).

### 4.6 Finish the visit (save & exit) — replaces "Edit"
When done at a PDV, a clear primary action **"Finalizar relevamiento"** →
`POST /v1/in-store/visits/:id/finish` → clears the active visit → returns to §4.2
to start the next PDV. Confirm first (`¿Finalizar el relevamiento de <store>?`)
and show the saved counts (`X productos, Y fotos`).

> **Do not** repurpose the top-right **Editar** (name/place) as the way to leave a
> PDV. "Editar" only corrects the worker name / current location; leaving a store
> is always **Finalizar relevamiento**.

---

## 5. Behaviors decided with the client

| Topic | Decision |
|---|---|
| **Barcode scanner** | Native `BarcodeDetector` on Android; **ZXing-WASM ponyfill** fallback on iOS (see §6). Responsive mobile web, no PWA for now. |
| **Location per PDV** | Captured once when starting a visit (provincia / localidad / dirección). Prepopulate from the last visit to the same store. |
| **Four fields** | Regular (unit) required; wholesale price, wholesale min-units, and observations optional. |
| **Promotions** | Handled via **flyer photos** on the visit — not a per-product promo flag. |
| **Finish visit** | Explicit "Finalizar relevamiento" saves & exits; not the top-right Edit. |
| **Duplicate scan same day** | **Warn and update.** If the product is already in the visit list, show `Ya cargaste este — ¿actualizar?` and let them re-submit (new snapshot). Don't silently double-log; don't hard-block. |
| **Offline** | **Queue locally and auto-retry** (see §7). Stores often have poor signal. |
| **Dates** | Never shown/picked; server-stamped. |
| **Conflicts with web/revista chains** | Backend allows duplicates. Makro/Vital/Maxiconsumo appear in the dropdown alongside the 5 wholesale-only chains. |

---

## 6. Barcode scanning (the key UX piece)

**You do NOT need a PWA.** Camera access (`getUserMedia`) and barcode decoding both
work in a plain mobile browser tab over HTTPS. A PWA would only add a home-screen
icon / fullscreen — nice later, not required now.

Recommended approach — **one feature-detecting interface**:

- **Android / Chrome:** the native `BarcodeDetector` API (fast, accurate, handles
  angled codes). ~94% of Chrome installs support it.
- **iOS Safari (no native support):** fall back to a WebAssembly decoder. Use the
  [`barcode-detector`](https://github.com/Sec-ant/barcode-detector) ponyfill
  (ZXing-C++ WASM under the hood) — it exposes the *same* `BarcodeDetector` API, so
  your code calls one interface and the ponyfill uses native when present, WASM
  otherwise.

```ts
import { BarcodeDetector } from 'barcode-detector/ponyfill';

const detector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e'] });

// In an animation-frame loop over a <video> playing the rear camera stream:
const codes = await detector.detect(videoEl);
if (codes.length) onScanned(codes[0].rawValue); // debounce identical reads
```

Camera setup notes:

- Request the **rear camera**: `getUserMedia({ video: { facingMode: { ideal: 'environment' } } })`.
- Must be served over **HTTPS** (already true behind Caddy).
- Provide a **torch/flashlight toggle** where supported
  (`track.applyConstraints({ advanced: [{ torch: true }] })`) — wholesale aisles are
  often dim.
- Show a scan-region overlay; debounce so one physical scan fires once.
- Always keep a **manual EAN text input** as a fallback for damaged/unreadable
  barcodes.

If real-world iOS accuracy on worn wholesale packaging proves poor, the paid
upgrade path is a commercial SDK (e.g. STRICH) with the same integration shape —
but start with the free ponyfill.

---

## 7. Offline resilience

Physical wholesale stores frequently have bad signal. Don't lose a worker's scans.

- On submit, **enqueue the entry locally** (`localStorage`/IndexedDB) with the
  active `visit_id` and try to `POST` immediately.
- If offline / the request fails, keep it queued and **auto-retry** when
  connectivity returns (`window.addEventListener('online', flush)` + periodic
  retry).
- Show a small indicator: `N pendientes de subir`. Optimistically add the entry to
  the visit list and counter; reconcile after the POST succeeds (attach the real
  `entry_id`).
- The `lookup` call needs connectivity; if offline, allow submitting anyway with the
  raw EAN (the backend resolves it on upload) — show the EAN until it syncs.
- **Start-visit and finish-visit** need connectivity. If offline at start, allow a
  provisional local visit and create it (POST /visits) as soon as you're online,
  then backfill `visit_id` on the queued entries. Photos should also queue.

---

## 8. API reference (summary — full detail in `API.md`)

Base URL: `VITE_API_BASE_URL`. Header on every request:
`X-API-Key: <VITE_INSTORE_API_KEY>`. Standard envelope:
`{ data, meta }` (or `{ data, pagination, meta }`); errors are
`{ error: { code, message, details? } }`.

### `GET /v1/in-store/supermarkets`
The store dropdown. → `data: { id, name, display_name }[]`.

### `GET /v1/in-store/lookup?ean=<8–14 digits>`
Resolve a scan (read-only). →
```ts
{ ean: string; found: boolean; product: {
    product_id: string | null; ean: string; name: string; brand: string | null;
    manufacturer: string | null; category: string | null; subcategory: string | null;
    format: string | null; variety: string | null;
    image_url: string | null;   // product photo; null for catalog-only matches (show a placeholder)
    source: 'products' | 'catalog';
  } | null }
```
`found: false` → not in catalog → let the worker skip.

### `POST /v1/in-store/visits`
Start a PDV relevamiento. Body:
```ts
{ supermarket_id: string; entered_by: string;   // required
  provincia?: string|null; localidad?: string|null; direccion?: string|null; note?: string|null }
```
→ **201** `{ id, supermarket_id, provincia, localidad, direccion, entered_by, note,
status, started_at, finished_at }`. Keep `id` as the active visit.

### `GET /v1/in-store/visits?date=&supermarket_id=&status=&entered_by=&page=&limit=`
List visits (defaults to today, Buenos Aires). Item = visit shape + `supermarket_name`.

### `GET /v1/in-store/visits/:id`
One visit + `counts: { entries, photos }`.

### `POST /v1/in-store/visits/:id/finish`
Save & close the visit. Idempotent. → visit with `status:"finished"`, `finished_at`,
`counts`.

### `POST /v1/in-store/visits/:id/photos?caption=`
Upload one flyer/offer photo — **raw image bytes as the body**, `Content-Type:
image/*` (not JSON/multipart). PNG/JPEG/WebP/GIF ≤ 15 MB. → **201** `{ id, visit_id,
supermarket_id, url, caption, entered_by, created_at }`.

### `GET /v1/in-store/visits/:id/photos`
List a visit's photos (newest first), same item shape as the upload.

### `POST /v1/in-store/entries`
Submit one price. Body:
```ts
{
  visit_id: string;          // preferred — inherits store/worker/location
  // ...or, without a visit: supermarket_id + entered_by
  ean: string;               // required, 8–14 digits
  price: number;             // required, > 0 — Precio Regular (unitario)
  wholesale_price?: number|null;      // Precio con oferta (precio mayorista)
  wholesale_min_units?: number|null;  // Promoción: min units for the wholesale price
  note?: string|null;                 // Observaciones
}
```
→ **201** `{ entry_id, visit_id, supermarket_id, ean, product_id,
supermarket_product_id, snapshot_id, price, wholesale_price, wholesale_min_units,
note, entered_by, created_at }`. Errors: `400` (bad body / chain not enabled /
finished visit), `404` (unknown store/visit / EAN not in catalog).

### `GET /v1/in-store/entries?visit_id=&date=&supermarket_id=&entered_by=&page=&limit=`
Recent submissions (defaults to today, Buenos Aires). Paginated. Item:
`{ id, visit_id, supermarket_id, supermarket_name, ean, product_id, product_name,
brand, price, wholesale_price, wholesale_min_units, note, entered_by, created_at }`.

---

## 9. Suggested build checklist

1. App shell: name prompt (persisted); header with worker name + active-visit chip.
2. Start-visit screen: store dropdown + location fields; `POST /visits`; persist
   the active visit.
3. Camera + scanner module (feature-detect native vs ponyfill; torch; overlay;
   manual EAN input).
4. Scan loop: lookup (name + image) → four fields → `POST /entries { visit_id }` →
   back to scanner.
5. Flyer photos: capture/upload to the visit; thumbnail strip.
6. Visit list (from `GET /entries?visit_id=`), with the "ya cargado" guard.
7. Finish-visit action (`POST /visits/:id/finish`) → clear active visit → back to
   start-visit. (Do **not** use the top-right Edit for this.)
8. Offline queue + retry + pending indicator (entries, visit create, photos).
9. Error/empty states: not-in-catalog skip, network errors, camera-permission denied.
10. (Optional, later) PWA manifest + service worker for install/fullscreen.
```

