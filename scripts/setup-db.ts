/**
 * One-time DB seed.
 *
 * Run after `migrations/001_initial_schema.sql` has been applied. Inserts the
 * minimum data the worker needs to start processing jobs:
 *
 *   - "coto" supermarket row (idempotent — upsert by id)
 *
 * Add more supermarkets here as adapters are written.
 *
 * Usage:
 *   npx tsx scripts/setup-db.ts
 */

import { db } from '../src/shared/db.js';
import { logger } from '../src/shared/logger.js';

interface SupermarketSeed {
  id: string;
  name: string;
  base_url: string;
  rate_limit_ms: number;
  concurrency: number;
}

const SUPERMARKETS: SupermarketSeed[] = [
  {
    id: 'coto',
    name: 'Coto Digital',
    base_url: 'https://www.cotodigital.com.ar',
    // Coto uses their own JSON API — be polite but no need to crawl slowly
    rate_limit_ms: 250,
    concurrency: 4,
  },
  {
    id: 'carrefour',
    name: 'Carrefour Argentina',
    base_url: 'https://www.carrefour.com.ar',
    // VTEX catalog API — generous public quotas, but stay polite
    rate_limit_ms: 250,
    concurrency: 4,
  },
  {
    id: 'maxi-carrefour',
    name: 'Carrefour Maxi Pedido',
    base_url: 'https://comerciante.carrefour.com.ar',
    // Custom PHP backend, prices gated by PHPSESSID. Crawl slowly so we don't
    // burn the session.
    rate_limit_ms: 1000,
    concurrency: 2,
  },
  {
    id: 'maxiconsumo',
    name: 'Maxiconsumo',
    base_url: 'https://maxiconsumo.com',
    // Magento 2 SSR HTML — full pages are ~700 KB each, take it slow
    rate_limit_ms: 1500,
    concurrency: 2,
  },
  {
    id: 'atomo',
    name: 'Átomo Conviene',
    base_url: 'https://atomoconviene.com',
    // PrestaShop SSR HTML, JSON-LD per page; ~350 KB
    rate_limit_ms: 1000,
    concurrency: 2,
  },
  {
    id: 'lacoopeencasa',
    name: 'La Coope en Casa',
    base_url: 'https://www.lacoopeencasa.coop',
    // Be2 JSON API — small, fast, no auth needed
    rate_limit_ms: 250,
    concurrency: 4,
  },
];

async function main(): Promise<void> {
  for (const sm of SUPERMARKETS) {
    const { error } = await db
      .from('supermarkets')
      .upsert(
        {
          id: sm.id,
          name: sm.name,
          base_url: sm.base_url,
          rate_limit_ms: sm.rate_limit_ms,
          concurrency: sm.concurrency,
          is_active: true,
        },
        { onConflict: 'id' },
      );
    if (error) {
      logger.error({ err: error, supermarket: sm.id }, 'failed to upsert supermarket');
      process.exitCode = 1;
      continue;
    }
    logger.info({ supermarket: sm.id }, 'upserted supermarket');
  }
}

void main();
