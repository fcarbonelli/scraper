/**
 * Run the bank/card promotions pipeline manually (test / backfill).
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/promos-run.ts [--provider=<id>] [--dry-run]
 *
 * - `--provider=<id>`  restrict to one provider (e.g. naranjax)
 * - `--dry-run`        fetch + normalize but do NOT write to the DB
 *
 * Forces a run even when PROMOS_ENABLED=false (this IS the explicit trigger).
 * NB: PowerShell drops `--` in `npm run … -- <flags>`; use `npx tsx` directly.
 */

import { runPromoCheck } from '../src/promos/pipeline.js';
import { logger } from '../src/shared/logger.js';

function parseArg(prefix: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(prefix));
  return a ? a.slice(prefix.length) : undefined;
}

async function main(): Promise<void> {
  const providerId = parseArg('--provider=');
  const dryRun = process.argv.includes('--dry-run');

  logger.info({ providerId, dryRun }, 'promos:run starting');
  const summaries = await runPromoCheck({ providerId, dryRun, force: true });

  // eslint-disable-next-line no-console
  console.log('\n=========== PROMOS RUN SUMMARY ===========');
  for (const s of summaries) {
    // eslint-disable-next-line no-console
    console.log(
      `${s.providerId.padEnd(12)} fetched=${s.fetched} created=${s.created} ` +
        `snapshotted=${s.snapshotted} unchanged=${s.unchanged} ` +
        `deactivated=${s.deactivated}` +
        (s.error ? `  ERROR: ${s.error}` : ''),
    );
  }
  // eslint-disable-next-line no-console
  console.log('==========================================\n');

  const failed = summaries.some((s) => s.error);
  process.exit(failed ? 1 : 0);
}

void main().catch((err) => {
  logger.fatal({ err }, 'promos:run failed');
  process.exit(1);
});
