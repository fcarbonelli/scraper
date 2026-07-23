/**
 * One-shot reconcile: pause active revista mappings whose only approvals live
 * on already-superseded magazines. Cleans export leftovers from before
 * pause-on-supersede existed (e.g. jul2mm / jul2sponso still active).
 *
 * Idempotent. Needs only Supabase env.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/revistas-reconcile-active.ts --dry-run
 *   npx tsx --env-file=.env scripts/revistas-reconcile-active.ts
 *   npx tsx --env-file=.env scripts/revistas-reconcile-active.ts --super=makro
 */

import { reconcileRevistaActiveMappings } from '../src/revistas/approve.js';

/* eslint-disable no-console */

function getArg(name: string): string | undefined {
  const pref = `--${name}=`;
  return process.argv.find((a) => a.startsWith(pref))?.slice(pref.length);
}

async function main(): Promise<void> {
  const supermarketId = getArg('super');
  const dryRun = process.argv.includes('--dry-run');

  console.log(
    `\nRECONCILE REVISTA ACTIVE MAPPINGS${supermarketId ? ` — ${supermarketId}` : ''}${dryRun ? ' (DRY-RUN)' : ''}\n`,
  );

  const result = await reconcileRevistaActiveMappings(supermarketId, { dryRun });
  console.log(
    dryRun
      ? `DRY-RUN — considered=${result.considered} would_pause=${result.paused} (no writes)\n`
      : `Done. considered=${result.considered} paused=${result.paused}\n`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error('revistas-reconcile-active failed:', err);
  process.exit(1);
});
