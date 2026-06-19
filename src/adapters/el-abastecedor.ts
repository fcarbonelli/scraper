/**
 * El Abastecedor adapter (VTEX).
 *
 * Buenos Aires wholesaler-style chain on VTEX (abastecedor.com.ar). The
 * storefront UI gates prices behind a login modal, BUT the public VTEX Catalog
 * API still returns prices, stock and EAN search anonymously — so no auth is
 * needed: the standard factory works as-is. Product URLs are `/<slug>/p`, and
 * EAN search works via `fq=alternateIds_Ean:<ean>`. See src/adapters/vtex.ts.
 */

import { createVtexAdapter } from './vtex.js';

export const elAbastecedorAdapter = createVtexAdapter({
  id: 'el-abastecedor',
  name: 'El Abastecedor',
  host: 'www.abastecedor.com.ar',
});
