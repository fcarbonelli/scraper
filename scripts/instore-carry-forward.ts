/**
 * Manually run the in-store price carry-forward.
 *
 * Re-emits each active in-store mapping's latest hand-entered price as a fresh
 * run-less snapshot dated today (idempotent per day). The orchestrator does
 * this automatically every day; this script is for testing/backfilling on
 * demand. No AI, no scraping — needs only Supabase env.
 *
 * Usage:
 *   npm run instore:carry-forward
 */

import { carryForwardInStorePrices } from '../src/instore/carryForward.js';
import { logger } from '../src/shared/logger.js';

async function main(): Promise<void> {
  const result = await carryForwardInStorePrices();
  logger.info({ result }, 'instore carry-forward complete');
  process.exit(0);
}

void main();
