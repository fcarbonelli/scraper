/**
 * Cordiez adapter (VTEX).
 *
 * Cordiez is a Córdoba regional chain on VTEX. Standard VTEX storefront — all
 * logic lives in the shared factory; only the id/name/host differ. See
 * src/adapters/vtex.ts for how it works.
 */

import { createVtexAdapter } from './vtex.js';

export const cordiezAdapter = createVtexAdapter({
  id: 'cordiez',
  name: 'Cordiez',
  host: 'www.cordiez.com.ar',
});
