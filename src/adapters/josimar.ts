/**
 * Josimar adapter (VTEX).
 *
 * Josimar is a Buenos Aires (GBA) regional chain on VTEX. Standard VTEX
 * storefront — product URLs are `/<slug>/p`, the public Catalog API resolves
 * ids/prices, and EAN search works via `fq=alternateIds_Ean:<ean>`. All logic
 * lives in the shared factory; only the id/name/host differ. See
 * src/adapters/vtex.ts for how it works.
 */

import { createVtexAdapter } from './vtex.js';

export const josimarAdapter = createVtexAdapter({
  id: 'josimar',
  name: 'Josimar',
  host: 'www.josimar.com.ar',
});
