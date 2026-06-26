/**
 * Comodín en Casa adapter (VTEX).
 *
 * NOA supermarket chain (Grupo Alberdi — Jujuy/Salta) on VTEX
 * (comodinencasa.com.ar). Standard storefront: the public Catalog API returns
 * prices, stock and EAN search anonymously, product URLs are `/<slug>/p`, and
 * availability is regionalized by postal code (multiple `alberdisa*` sellers per
 * region). All logic lives in the shared factory; the default sales channel
 * ("Main", sc=1) carries the retail catalog and the geo-fallback covers
 * region-limited products — so only id/name/host differ. See src/adapters/vtex.ts.
 *
 * (There is a separate sc=2 "Supermercado Mayorista" wholesale catalog; we
 * intentionally do NOT sweep it, since it's a different pricing tier from the
 * retail prices we track.)
 */

import { createVtexAdapter } from './vtex.js';

export const comodinAdapter = createVtexAdapter({
  id: 'comodin',
  name: 'Comodín en Casa',
  host: 'www.comodinencasa.com.ar',
});
