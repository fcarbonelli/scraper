# In-store price entry — frontend build spec

This is the complete specification for the **in-store manual price-entry** tool: a
mobile-web app where a field worker, physically inside a (mostly wholesale) store,
**scans a product barcode and types the shelf price**. It's meant for high-volume
sessions — a worker checks a few hundred products per visit — and must feel like
"open, type your name, and just scan."

The backend is **already implemented** (`src/instore/`, routes at `/v1/in-store/*`).
This doc is the contract + UX brief the frontend is built against. API details are
mirrored in [`API.md`](../API.md) → *In-store (manual price entry)*, with JSON
fixtures in [`examples/api/`](../examples/api/) (`in-store-*.json`).

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
- Duplicates are allowed backend-side (multiple entries the same day just create
  multiple snapshots). The UI adds a light guard against *accidental* re-scans
  (see §5).

---

## 2. Authentication (important — no per-user logins)

- The app embeds **one API key**, sent as the `X-API-Key` header on every request.
  Field workers never receive or type a key.
- That key is **scoped to `in-store`**: it can reach **only** `/v1/in-store/*`. Any
  other endpoint returns `403 FORBIDDEN`. So a leaked app key can't touch the rest
  of the API. (Backoffice mints it with
  `npm run apikey:create -- instore-app --scope=in-store`.)
- **Attribution is by name, not by account.** On first open, the app asks for the
  worker's name, stores it in `localStorage`, and sends it as `entered_by` on every
  submission. `entered_by` is **required** — don't allow submitting without it.

Config the frontend needs:

```
VITE_API_BASE_URL   e.g. https://api.megaanalytics.com/v1
VITE_INSTORE_API_KEY the in-store-scoped key
```

---

## 3. Session model (set once, then just scan)

Two pieces of state persist in `localStorage` and are **not** re-prompted on reload:

| State | Behavior |
|---|---|
| **Worker name** | Prompted once on first open. Shown as a small, editable label in the header (tap to correct). Sent as `entered_by`. |
| **Selected store** | Chosen once at the start of a visit. Shown as a persistent, prominent header chip (e.g. `📍 DIARCO`). Changeable, but a change pops a confirm (`¿Cambiar de supermercado a …?`) so it never switches by accident mid-session. |

A worker can lock their phone and come back later — same store, same name, ready to
scan. Nothing to reset between visits.

---

## 4. Screens & flow

### 4.1 First-run / setup

1. Ask for the worker's **name** (required) → save to `localStorage`.
2. Show the **store dropdown** (from `GET /v1/in-store/supermarkets`) → save choice.
3. Go to the scan screen.

### 4.2 Scan screen (the main loop)

Optimize for hundreds of quick entries. The cycle must be: **scan → confirm → type
price → submit → back to scanner**, with minimal taps.

1. **Live camera** is always on (after each submit it returns straight to the
   scanner — no "start scanning" tap).
2. On a decoded barcode:
   - Give immediate feedback (haptic `navigator.vibrate(50)` + a short beep).
   - Auto-fill the EAN and call `GET /v1/in-store/lookup?ean=`.
3. **If found** → show the product name/brand (so they confirm it's the right item)
   and **auto-focus the price field** with the numeric keypad already up
   (`<input inputmode="decimal">`).
4. Type price → big **Guardar** button → `POST /v1/in-store/entries`.
   - On success: toast `✓ Guardado (#N)`, bump the counter, return to live scanner.
5. **Optional promo:** a `+ promoción / oferta` toggle reveals two fields — *Precio
   de oferta* (numeric) and *Descripción* (free text like `2x1`, `-30%`). Most
   products won't use it; keep the default path a single price field.
6. **If not found** (`found: false`) → clear message `No está en el catálogo` and a
   one-tap **Omitir** so they keep moving.

Header (persistent): store chip · worker name · counter (`N cargados hoy`).

### 4.3 Today's list

A collapsible list of **everything uploaded today for the currently selected store**
(from `GET /v1/in-store/entries` — defaults to today). Each row: product name,
price, promo (if any), time. Lets the worker spot/fix a mistake. Optionally allow
re-submitting a corrected price (just another `POST`).

---

## 5. Behaviors decided with the client

| Topic | Decision |
|---|---|
| **Barcode scanner** | Native `BarcodeDetector` on Android; **ZXing-WASM ponyfill** fallback on iOS (see §6). No PWA for now — responsive mobile web. |
| **Duplicate scan same day** | **Warn and update.** If the product is already in today's list, show `Ya cargaste este hoy — ¿actualizar?` and let them re-submit (creates a new snapshot). Don't silently double-log; don't hard-block. |
| **Today's list scope** | Everything uploaded **today for the selected store**. Resets naturally each day (Buenos Aires date). |
| **Offline** | **Queue locally and auto-retry** (see §7). Stores often have poor signal. |
| **Promotions** | Optional; hidden behind a toggle. |
| **Dates** | Never shown/picked; server-stamped. |
| **Conflicts with web/revista chains** | Backend allows duplicates — no frontend handling needed. Makro/Vital/Maxiconsumo appear in the dropdown alongside the 5 wholesale-only chains. |

The store dropdown is **data-driven** — always render exactly what
`GET /v1/in-store/supermarkets` returns (currently: Nini, Diarco, Makro, Vital,
Yaguar, Maxiconsumo, Don Gastón, Oscar David). Don't hardcode the list.

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

- On submit, **enqueue the entry locally** (`localStorage`/IndexedDB) and try to
  `POST` immediately.
- If offline / the request fails, keep it queued and **auto-retry** when
  connectivity returns (`window.addEventListener('online', flush)` + periodic
  retry).
- Show a small indicator: `N pendientes de subir`. Optimistically add the entry to
  the today's-list and counter; reconcile after the POST succeeds (attach the real
  `entry_id`).
- The `lookup` call needs connectivity; if offline, allow submitting anyway with the
  raw EAN (the backend resolves it on upload) — just show the EAN instead of a
  product name until it syncs.

This is also the natural stepping stone if you later add the PWA layer.

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
    format: string | null; variety: string | null; source: 'products' | 'catalog';
  } | null }
```
`found: false` → not in catalog → let the worker skip.

### `POST /v1/in-store/entries`
Submit one price. Body:
```ts
{
  supermarket_id: string;   // required (must be an instore-enabled chain)
  ean: string;              // required, 8–14 digits
  price: number;            // required, > 0 (regular / shelf price)
  promo_price?: number|null;// offer price when there's a promo
  promo_text?: string|null; // e.g. "2x1", "-30%"
  entered_by: string;       // required — worker name from localStorage
  note?: string|null;
}
```
→ **201** `{ entry_id, supermarket_id, ean, product_id, supermarket_product_id,
snapshot_id, price, list_price, promo_price, promo_text, entered_by, created_at }`.
Errors: `400` (bad body / chain not enabled), `404` (unknown store / EAN not in
catalog).

### `GET /v1/in-store/entries?date=&supermarket_id=&entered_by=&page=&limit=`
Recent submissions (defaults to today, Buenos Aires). Paginated. Item shape:
`{ id, supermarket_id, supermarket_name, ean, product_id, product_name, brand,
price, list_price, promo_price, promo_text, entered_by, note, created_at }`.

---

## 9. Suggested build checklist

1. App shell: name prompt + store dropdown, both persisted; header chip + counter.
2. Camera + scanner module (feature-detect native vs ponyfill; torch; overlay;
   manual EAN input).
3. Scan loop: lookup → confirm → price → submit → back to scanner; promo toggle.
4. Today's list (from `GET /entries`), with the "ya cargado hoy" guard.
5. Offline queue + retry + pending indicator.
6. Error/empty states: not-in-catalog skip, network errors, camera-permission
   denied.
7. (Optional, later) PWA manifest + service worker for install/fullscreen.
