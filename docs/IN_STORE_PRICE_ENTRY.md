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

- A submission is **pending** until a back-office operator approves it. Nothing
  reaches the client export until the day's data is reviewed and approved (§10) —
  the same idea as the online scraper's daily publish. On approval the price
  becomes a **run-less** snapshot in the client export.
- The field worker's app still works exactly the same; their own "today's list"
  shows their entries with a `review_status` (`pending` at first).
- Prices are entered only **every few days** (≈twice a week). Each approved price
  publishes **only on the day it's approved** — it is a single row dated that day.
  There is **no carry-forward**: prices do NOT keep exporting on later days between
  visits. **The frontend does nothing for this.**
- The worker **never picks a date.** The server stamps every entry with the current
  time. There is no date field anywhere in the UI.
- If the product is on the shelf but the **price is unreadable**, the worker records
  it with **"Sin precio / hay stock"** (`no_price`) instead of a fake $1/$0. On
  approval it publishes as a **marker** (`Estado = "En stock sin precio"`, price
  columns blank) — the client sees the product is stocked, price unknown.
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
5. **"Sin precio / hay stock" button.** When the worker sees the product on the
   shelf but can't read its price, they tap this instead of typing a fake $1/$0.
   It submits `POST /v1/in-store/entries` with `{ visit_id, ean, no_price: true }`
   (**no** `price` — sending both is a `400`). The product still gets recorded and,
   on approval, appears in the client export as a **marker**: `Estado = "En stock
   sin precio"` with the price columns blank. This keeps garbage prices out of the
   data and means the reviewer doesn't have to second-guess a suspicious $1.
   Style it as a secondary action next to **Guardar** (e.g. `Sin precio`), and skip
   the price fields entirely when it's used.
6. On success (either path): toast `✓ Guardado (#N)` — for a no-price entry show
   `✓ Sin precio (#N)` — bump the counter, return to live scanner.
7. **If not found** (`found: false`) → `No está en el catálogo` + one-tap **Omitir**.

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

### 4.5 Today's list (with in-place edit)
A collapsible list of everything uploaded **in the active visit** (or today for the
store) from `GET /v1/in-store/entries?visit_id=` (or default = today). Each row:
product name, regular price, wholesale price + min-units (if any), observations,
time, and `review_status`. When `no_price` is `true`, show a `Sin precio` chip
instead of a price (the `price` field is `null`).

**Editing a saved entry.** Each still-`pending` row is editable in place: tap it,
change the price / wholesale / min-units / observaciones, and save with
`PATCH /v1/in-store/entries/:id`. It persists immediately — **no approval needed**.
You can also fix a no-price case here: send `no_price: true` to flag one, or send a
`price` to convert a `Sin precio` row into a real price (that clears the flag).
This is the fix-a-mistake flow the client asked for (don't require re-scanning or
re-approving). Once an entry is `approved` the PATCH returns `400`, so hide/disable
edit for non-pending rows (in practice everything the field worker sees is
pending).

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
| **Barcode scanner** | **ZXing-WASM ponyfill** en todos los navegadores (ver §6). |
| **PWA** | **Sí, ya está** (era "no PWA for now"). Manifest + service worker acotados a `/instore`: sin eso la app ni siquiera abría sin señal y la cola de §7 nunca llegaba a correr. |
| **Location per PDV** | Captured once when starting a visit (provincia / localidad / dirección). Prepopulate from the last visit to the same store. |
| **Four fields** | Regular (unit) required; wholesale price, wholesale min-units, and observations optional. |
| **Price unreadable** | A **"Sin precio / hay stock"** action (`no_price: true`, no price) instead of a fake $1/$0. Publishes as a marker (`Estado = "En stock sin precio"`, price blank), so no garbage prices and nothing to second-guess in review. |
| **Promotions** | Handled via **flyer photos** on the visit — not a per-product promo flag. |
| **Finish visit** | Explicit "Finalizar relevamiento" saves & exits; not the top-right Edit. |
| **Duplicate scan same day** | **Warn and update.** If the product is already in the visit list, show `Ya cargaste este — ¿actualizar?` and let them re-submit (new snapshot). Don't silently double-log; don't hard-block. |
| **Offline** | **Queue locally and auto-retry** (see §7). Stores often have poor signal. |
| **Dates** | Never shown/picked; server-stamped. |
| **Conflicts with web/revista chains** | Backend allows duplicates. Makro/Vital/Maxiconsumo appear in the dropdown alongside the 5 wholesale-only chains. |

---

## 6. Barcode scanning (the key UX piece)

> **Corregido.** Este apartado decía "You do NOT need a PWA" y que el ponyfill usa
> el `BarcodeDetector` nativo en Android. Las dos cosas eran falsas:
>
> 1. **Sí hace falta la PWA**, no por el ícono sino porque sin service worker la
>    app no abre sin señal (ver §7 y §11).
> 2. **`barcode-detector/ponyfill` usa ZXing SIEMPRE**, en todos los navegadores.
>    El que hace feature-detect del nativo es el entry point `/polyfill`.
>    Verificado en `node_modules`.

Se usa [`barcode-detector`](https://github.com/Sec-ant/barcode-detector) (ZXing-C++
compilado a WASM), que expone la misma interfaz `BarcodeDetector` en todos lados.

**El `.wasm` hay que auto-hostearlo.** `zxing-wasm` trae `locateFile` apuntado por
defecto al CDN de jsDelivr (~1 MB). Sin señal no se puede bajar y el fallo es
**mudo**: el `catch` del loop de detección se come la excepción y la cámara nunca
pitea, sin ningún cartel. Se copia a `public/` en el build y se precachea en el
service worker; el override se registra con `prepareZXingModule({ overrides:
{ locateFile } })`.

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
  **Mejorado:** con `GET /v1/in-store/catalog` bajado de antemano (§8), el escaneo
  offline igual muestra nombre y marca; el EAN crudo queda sólo como último
  recurso cuando el catálogo local todavía está vacío. Bajarlo **al abrir la app**
  con señal, no al iniciar el relevamiento: el peor caso es alguien que instala la
  app y se va derecho a la tienda.
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

### `GET /v1/in-store/catalog`
El catálogo entero (~238 filas, ~90 KB) en una sola respuesta, para guardarlo en
el dispositivo y poder mostrar nombre/marca al escanear **sin conexión**. Cada
item tiene la misma forma que el `product` de `lookup`, ordenado por `ean`. Sin
paginación a propósito. Trae `ETag`: mandalo como `If-None-Match` y si el
catálogo no cambió responde `304` sin cuerpo, así refrescar en cada apertura de
la app sale gratis.

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
  price?: number;            // > 0 — Precio Regular (unitario); omit when no_price
  wholesale_price?: number|null;      // Precio con oferta (precio mayorista)
  wholesale_min_units?: number|null;  // Promoción: min units for the wholesale price
  no_price?: boolean;                 // "Sin precio / hay stock" (omit price)
  note?: string|null;                 // Observaciones
}
```
Provide **either** `price` **or** `no_price: true` (not both). → **201** `{ entry_id,
visit_id, supermarket_id, ean, product_id, product_name, price, wholesale_price,
wholesale_min_units, no_price, note, entered_by, review_status, created_at }`
(`price` is `null` for a no-price entry). **No snapshot yet** — the entry is
`pending` until approved (§10). Errors: `400` (bad body / missing price without
`no_price` / chain not enabled / finished visit), `404` (unknown store/visit / EAN
not in catalog).

### `PATCH /v1/in-store/entries/:id`
Edit a saved **pending** entry (fix price / units / observaciones / no_price); saves
without approval. Body (≥1 field; omitted = unchanged, `null` clears):
```ts
{ price?: number; wholesale_price?: number|null; wholesale_min_units?: number|null; no_price?: boolean; note?: string|null }
```
Sending `no_price: true` clears the price/wholesale; sending a `price` clears
`no_price`. → **200** with the updated entry (same shape as the `POST /entries` 201
body). `404` unknown entry; `400` empty body or entry already approved/rejected.

### `GET /v1/in-store/entries?visit_id=&date=&supermarket_id=&entered_by=&review_status=&page=&limit=`
Recent submissions (defaults to today, Buenos Aires; `date` is ignored when
`visit_id` is set). Paginated. Item: `{ id, visit_id, supermarket_id,
supermarket_name, ean, product_id, product_name, brand, price, wholesale_price,
wholesale_min_units, no_price, note, entered_by, review_status, created_at }`.

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
6. Visit list (from `GET /entries?visit_id=`), with the "ya cargado" guard **and
   in-place edit of pending rows** (`PATCH /entries/:id`).
7. Finish-visit action (`POST /visits/:id/finish`) → clear active visit → back to
   start-visit. (Do **not** use the top-right Edit for this.)
8. Offline queue + retry + pending indicator (entries, visit create, photos, **finish**).
9. Error/empty states: not-in-catalog skip, network errors, camera-permission denied.
10. ~~(Optional, later)~~ **PWA manifest + service worker — hecho, y NO era opcional:
    sin service worker la app no abre sin señal y nada de §7 llega a ejecutarse.**
11. Catálogo bajado al abrir la app (`GET /catalog`), guardado en IndexedDB, para
    ver nombre/marca al escanear offline.

---

## 10. Back-office daily review (separate screen / app)

This is **not** part of the field-worker app — it's a back-office screen (in the
dashboard) that reviews each day's data before it reaches the client, the same way
you review the online scraper. **It uses a full-access API key, not the
`in-store`-scoped app key** (the review endpoints return `403` for a scoped key).

Flow:

1. **Review queue** — `GET /v1/in-store/review/pending` lists finished visits
   awaiting review (oldest first), each with `supermarket_name`, location, worker,
   and `pending_entries` count. Filter by `supermarket_id`.
2. **Review a visit** — `GET /v1/in-store/review/visits/:id` returns the visit +
   all its entries (with `product_name`, `brand`, `image_url`, the four price
   fields, `no_price`, and `review_status`). Entries with `no_price: true` show a
   `Sin precio` chip (no price to check — they publish as an "En stock sin precio"
   marker). Show the flyer photos too via `GET /v1/in-store/visits/:id/photos`.
3. **Approve** — `POST /v1/in-store/review/visits/:id/approve`:
   ```ts
   {
     reviewed_by: string;   // required — who signed off
     decisions?: {          // omit an entry → approved as-is; omit all → approve everything
       entry_id: string;
       action: 'approve' | 'reject';
       price?: number;                    // inline edits, on approve; clears no_price
       wholesale_price?: number | null;
       wholesale_min_units?: number | null;
       no_price?: boolean;                // flip to/from "sin precio" during review
       note?: string | null;
     }[];
   }
   ```
   Approving materializes each entry into the client base (a run-less snapshot);
   rejecting discards it. Response: `{ visit_id, approved, rejected, snapshots }`.
   The visit then drops out of the pending queue.

Once approved, each price exports **only on its approval day** (a single run-less
snapshot dated that day). There is no carry-forward, so the price does not re-appear
in later days' exports — the next visit records fresh prices on its own day.

