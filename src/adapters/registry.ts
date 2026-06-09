/**
 * Adapter registry.
 *
 * The worker uses this to look up the right adapter for a given
 * supermarket_id. To wire in a new supermarket: write your adapter file in
 * this folder, then `register(myAdapter)` it below.
 */

import type { SupermarketAdapter } from './types.js';
import { cotoAdapter } from './coto.js';
import { carrefourAdapter } from './carrefour.js';
import { maxiCarrefourAdapter } from './maxi-carrefour.js';
import { maxiconsumoAdapter } from './maxiconsumo.js';
import { atomoAdapter } from './atomo.js';
import { lacoopeencasaAdapter } from './lacoopeencasa.js';
import { veaAdapter } from './vea.js';
import { jumboAdapter } from './jumbo.js';
import { discoAdapter } from './disco.js';
import { changomasAdapter } from './changomas.js';
import { diaAdapter } from './dia.js';
import { cordiezAdapter } from './cordiez.js';

const adapters = new Map<string, SupermarketAdapter>();

function register(adapter: SupermarketAdapter): void {
  if (adapters.has(adapter.id)) {
    throw new Error(`Adapter already registered for id="${adapter.id}"`);
  }
  adapters.set(adapter.id, adapter);
}

// Wire all known adapters here -----------------------------------------------
register(cotoAdapter);
register(carrefourAdapter);
register(maxiCarrefourAdapter);
register(maxiconsumoAdapter);
register(atomoAdapter);
register(lacoopeencasaAdapter);
register(veaAdapter);
register(jumboAdapter);
register(discoAdapter);
register(changomasAdapter);
register(diaAdapter);
register(cordiezAdapter);

export function getAdapter(supermarketId: string): SupermarketAdapter {
  const adapter = adapters.get(supermarketId);
  if (!adapter) {
    throw new Error(`No adapter registered for supermarket id="${supermarketId}"`);
  }
  return adapter;
}

export function listAdapters(): SupermarketAdapter[] {
  return Array.from(adapters.values());
}

export interface AdapterCapabilities {
  hasAdapter: boolean;
  hasSearch: boolean;
}

/** Check what capabilities exist for a given supermarket. */
export function getAdapterCapabilities(supermarketId: string): AdapterCapabilities {
  const adapter = adapters.get(supermarketId);
  if (!adapter) return { hasAdapter: false, hasSearch: false };
  return {
    hasAdapter: true,
    hasSearch: typeof adapter.searchByEan === 'function',
  };
}
