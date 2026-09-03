/**
 * Josimar adapter (VTEX).
 *
 * Josimar is a Buenos Aires (GBA) regional chain on VTEX. Product URLs are
 * `/<slug>/p`, the public Catalog API resolves ids/prices, and EAN search works
 * via `fq=alternateIds_Ean:<ean>`. See src/adapters/vtex.ts.
 *
 * Sucursales = SALES CHANNELS (not postal-code regions). Verified live
 * (2026-08): the VTEX regions endpoint returns the SAME regionId with empty
 * sellers for every postal code, so the regionId geo-fallback can't
 * differentiate branches — a product missing in the default channel stays
 * missing no matter which CP we try. But querying the catalog with `sc=<n>`
 * DOES: the same product returns per-branch stock across channels (e.g.
 * productId 14206 has qty 111/74/84/72 on sc=1/3/5/6) at an IDENTICAL price
 * (only stock differs). Channels 3/5/6 are additional sucursales with the same
 * retail price list; the operator's reference sucursal ("Berazategui") is one
 * of them. So we sweep those channels: a product not carried at the default
 * channel (which came back as a daily "missing price" for the client) is
 * recovered from whichever sucursal stocks it, at the correct price.
 *
 * NB: channels 2/4 were left out on purpose — they returned empty for the
 * sampled products and their price list wasn't confirmed to match retail. Add
 * more channels here once verified.
 *
 * IMPORTANT (2026-09): the no-`sc` "default" catalog request is NOT the same as
 * `sc=1`. Josimar's storefront binding began returning EMPTY for the anonymous
 * no-`sc` request on a large set of products (verified live: ~19 client-flagged
 * items came back with no price), while `sc=1` — the actual retail channel —
 * returns them in stock at the correct price. So `1` MUST be in the swept
 * channel list: the sweep tries the no-`sc` default first (unchanged for
 * products that still resolve there) and then explicitly hits `sc=1`, which
 * recovers everything the bare request now drops.
 */

import { createVtexAdapter } from './vtex.js';

export const josimarAdapter = createVtexAdapter({
  id: 'josimar',
  name: 'Josimar',
  host: 'www.josimar.com.ar',
  // Sweep the retail channel (sc=1) + sucursal channels when the no-`sc`
  // default catalog is empty/out-of-stock for a product (see file header).
  // `1` is first because it's the main retail channel and now carries products
  // the bare no-`sc` request drops entirely.
  salesChannels: [1, 3, 5, 6],
});
