/**
 * El Abastecedor adapter (VTEX).
 *
 * Buenos Aires wholesaler-style chain on VTEX (abastecedor.com.ar). The
 * storefront UI gates prices behind a login modal, BUT the public VTEX Catalog
 * API still returns prices, stock and EAN search anonymously — so no auth is
 * needed: the standard factory works as-is. Product URLs are `/<slug>/p`, and
 * EAN search works via `fq=alternateIds_Ean:<ean>`. See src/adapters/vtex.ts.
 *
 * Sales-channel scoping: this is a pickup/branch wholesaler, so availability is
 * keyed off the VTEX SALES CHANNEL (trade policy), NOT a postal-code region —
 * a regionId-scoped catalog request still comes back empty. The default channel
 * sc=1 "Principal" carries most products, but branch-exclusive ones live only
 * in sc=2 "Martin Fierro" and/or sc=3 "La Reja" and would otherwise fail with
 * `region_unavailable`. We therefore sweep those channels (verified live
 * 2026-06: sc=2 returns price/stock for products empty in sc=1).
 */

import { createVtexAdapter } from './vtex.js';

export const elAbastecedorAdapter = createVtexAdapter({
  id: 'el-abastecedor',
  name: 'El Abastecedor',
  host: 'www.abastecedor.com.ar',
  // Sweep the branch sales channels when the default (sc=1) catalog is empty.
  salesChannels: [2, 3],
});
