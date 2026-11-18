/**
 * Vea adapter (VTEX / Cencosud).
 *
 * Standard VTEX storefront — all logic lives in the shared factory; only the
 * id/name/host differ. See src/adapters/vtex.ts for how it works. Promos come
 * from Cencosud's own endpoint (see cencosud-promotions.ts); the seller is the
 * store theme's default branch seller.
 */

import { createVtexAdapter } from './vtex.js';

export const veaAdapter = createVtexAdapter({
  id: 'vea',
  name: 'Vea',
  host: 'www.vea.com.ar',
  cencosudPromotions: { seller: 'jumboargentinav700cordoba700' },
});
