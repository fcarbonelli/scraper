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
