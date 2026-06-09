/**
 * ChangoMas adapter (VTEX).
 *
 * ChangoMas's online store is `masonline.com.ar` (the former Walmart Argentina
 * ecommerce). Standard VTEX storefront — all logic lives in the shared factory;
 * only the id/name/host differ. See src/adapters/vtex.ts for how it works.
 *
 * NB: the DB id stays `changomas` (matches the client's "Clientes" sheet /
 * display name) even though the host is masonline.com.ar.
 */

import { createVtexAdapter } from './vtex.js';

export const changomasAdapter = createVtexAdapter({
  id: 'changomas',
  name: 'ChangoMas',
  host: 'www.masonline.com.ar',
});
