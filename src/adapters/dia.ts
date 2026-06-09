/**
 * Día adapter (VTEX).
 *
 * Día's online store is `diaonline.supermercadosdia.com.ar`. Standard VTEX
 * storefront — all logic lives in the shared factory; only the id/name/host
 * differ. See src/adapters/vtex.ts for how it works.
 */

import { createVtexAdapter } from './vtex.js';

export const diaAdapter = createVtexAdapter({
  id: 'dia',
  name: 'Dia',
  host: 'diaonline.supermercadosdia.com.ar',
});
