/**
 * Maxi Carrefour session keepalive (CLI wrapper).
 *
 * The real logic lives in src/adapters/maxi-carrefour-keepalive.ts so it can be
 * shared with the orchestrator, which now runs this on a cron (env
 * MAXI_KEEPALIVE_CRON, default every 10 min) in production — so you normally
 * DON'T need to wire an external crontab anymore.
 *
 * Reach for this script to run the keepalive once, on demand (e.g. right after
 * re-seeding sessions locally, to confirm they're all warm):
 *
 *   npx tsx --env-file=.env scripts/maxi-carrefour-keepalive.ts
 *
 * Exits non-zero if every session is dead — a signal for an operator alert
 * while tolerating a single stale fallback.
 */

import { logger } from '../src/shared/logger.js';
import { runMaxiKeepalive } from '../src/adapters/maxi-carrefour-keepalive.js';

async function main(): Promise<void> {
  const { alive } = await runMaxiKeepalive(logger);
  // Non-zero exit if every session is dead.
  if (alive === 0) process.exitCode = 1;
}

main().catch((err) => {
  logger.error({ err }, 'maxi-keepalive: failed');
  process.exitCode = 1;
});
