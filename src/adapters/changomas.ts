/**
 * ChangoMas adapter (VTEX).
 *
 * ChangoMas's online store is `masonline.com.ar` (the former Walmart Argentina
 * ecommerce). It runs on VTEX, but unlike a plain storefront it splits its
 * inventory between one online DELIVERY seller ("1", "MasOnline") and many
 * per-branch PICKUP sellers. The public catalog API only ever returns seller
 * "1", so ~half our tracked products look out of stock even though CABA
 * branches still list them at a real price — and masonline's catalog ignores
 * the regionId trick that fixes other VTEX stores.
 *
 * So we enable `storeSellerFallback`: when seller "1" is out of stock / has no
 * price, the factory sweeps the CABA branch sellers via the checkout
 * simulation API and adopts the live branch's price (marking it in-stock only
 * when a branch is actually purchasable). See src/adapters/vtex-sellers.ts.
 *
 * NB: the DB id stays `changomas` (matches the client's "Clientes" sheet /
 * display name) even though the host is masonline.com.ar.
 */

import { createVtexAdapter } from './vtex.js';

export const changomasAdapter = createVtexAdapter({
  id: 'changomas',
  name: 'ChangoMas',
  host: 'www.masonline.com.ar',
  // CABA (postal code 1414) branch sellers carry accurate, live prices; the
  // sweep prefers a purchasable branch and otherwise records the real price
  // with inStock=false. Tune the postal code here if coverage needs to change.
  storeSellerFallback: { postalCode: '1414' },
});
