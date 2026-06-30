/**
 * Manual revista pipeline runner (for testing / backfill).
 *
 * Usage:
 *   npm run revistas:run                       # check every revista supermarket
 *   npm run revistas:run -- --super=makro      # only one chain
 *   npm run revistas:run -- --super=makro --pages=1-8   # only pages 1..8 (cheap)
 *   npm run revistas:run -- --force            # reprocess even if unchanged
 *
 * Needs OPENAI_API_KEY (vision + matching) and Supabase env (catalog + storage).
 */

import { logger } from '../src/shared/logger.js';
import {
  loadRevistaSupermarkets,
  processSupermarket,
  runRevistaCheck,
  type ProcessOptions,
} from '../src/revistas/pipeline.js';
import type { PageSelection } from '../src/revistas/sources-shared.js';

function getArg(name: string): string | undefined {
  const pref = `--${name}=`;
  return process.argv.find((a) => a.startsWith(pref))?.slice(pref.length);
}

/** Parse `--pages=1-8` or `--pages=5` into a PageSelection. */
function parsePages(): PageSelection | undefined {
  const raw = getArg('pages');
  if (!raw) return undefined;
  const [a, b] = raw.split('-');
  const start = Number(a);
  if (!Number.isFinite(start) || start < 1) return undefined;
  const end = b ? Number(b) : undefined;
  return end && Number.isFinite(end) ? { start, end } : { start };
}

async function main(): Promise<void> {
  const onlySuper = getArg('super');
  const force = process.argv.includes('--force');
  const pageSelection = parsePages();
  const opts: ProcessOptions = { scrapeRunId: null, force, ...(pageSelection ? { pageSelection } : {}) };

  if (onlySuper) {
    const supers = await loadRevistaSupermarkets();
    const sm = supers.find((s) => s.id === onlySuper);
    if (!sm) {
      logger.error({ onlySuper, available: supers.map((s) => s.id) }, 'no such revista supermarket (is config.source_type=revista and is_active=true?)');
      process.exit(1);
    }
    const summaries = await processSupermarket(sm, opts);
    logger.info({ summaries }, 'revista run complete');
  } else {
    const summaries = await runRevistaCheck(opts);
    logger.info({ count: summaries.length, summaries }, 'revista run complete');
  }
  process.exit(0);
}

main().catch((err) => {
  logger.fatal({ err }, 'revista run failed');
  process.exit(1);
});
