/**
 * Provider registry for the promotions module.
 *
 * Adding a new bank/issuer = write one provider file + register it here (and
 * insert a `promo_providers` row). The pipeline is provider-agnostic and only
 * ever looks providers up through this map.
 */

import type { PromoProvider } from './types.js';
import { naranjaxProvider } from './naranjax.js';

const providers = new Map<string, PromoProvider>();

function register(provider: PromoProvider): void {
  if (providers.has(provider.id)) {
    throw new Error(`Promo provider already registered for id="${provider.id}"`);
  }
  providers.set(provider.id, provider);
}

/** Returns the provider or undefined if none is registered for the id. */
export function getProvider(id: string): PromoProvider | undefined {
  return providers.get(id);
}

/** All registered providers. */
export function listProviders(): PromoProvider[] {
  return [...providers.values()];
}

// ---- registrations ------------------------------------------------------------
register(naranjaxProvider);
