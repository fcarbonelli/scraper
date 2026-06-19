/**
 * Supertop adapter (VTEX).
 *
 * "Supermercados Top" — a Córdoba regional chain (Río Cuarto, also San Luis) on
 * VTEX. Standard VTEX storefront: product URLs are `/<slug>/p`, the public
 * Catalog API resolves ids/prices, and EAN search works via
 * `fq=alternateIds_Ean:<ean>`. All logic lives in the shared factory; only the
 * id/name/host differ. See src/adapters/vtex.ts for how it works.
 */

import { createVtexAdapter } from './vtex.js';

export const supertopAdapter = createVtexAdapter({
  id: 'supertop',
  name: 'Supertop',
  host: 'www.supertop.com.ar',
});
