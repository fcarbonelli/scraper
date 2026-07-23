/**
 * Manual revista pipeline runner (for testing / backfill).
 *
 * Usage:
 *   npm run revistas:run                       # check every revista supermarket
 *   npm run revistas:run -- --super=makro      # only one chain
 *   npm run revistas:run -- --super=makro --pages=1-8   # only pages 1..8 (cheap)
 *   npm run revistas:run -- --force            # reprocess even if unchanged
 *   npm run revistas:run -- --carry-forward    # re-emit today's magazine prices (no AI, no scraping)
 *   npm run revistas:run -- --super=makro --url=<pdf>   # ingest one PDF by URL (skip discovery)
 *   npm run revistas:run -- --super=makro --skip-series=gt,sponsor
 *   npm run revistas:run -- --super=makro --only-series=mm,prov
 *
 * Needs OPENAI_API_KEY (vision + matching) and Supabase env (catalog + storage).
 * `--carry-forward` needs only Supabase env.
 *
 * PowerShell tip: pass flags AFTER `--` or call `npx tsx --env-file=.env scripts/scrape-revistas.ts …`
 * directly — `npm run … -- --flags` can drop `--` on Windows.
 */

import { logger } from '../src/shared/logger.js';
import {
  loadRevistaSupermarkets,
  processSupermarket,
  runRevistaCheck,
  ingestPdfUrl,
  type ProcessOptions,
} from '../src/revistas/pipeline.js';
import { carryForwardRevistaPrices } from '../src/revistas/carryForward.js';
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

/** Parse comma-separated series keys (`gt,sponsor`). */
function parseSeriesList(name: string): string[] | undefined {
  const raw = getArg(name);
  if (!raw) return undefined;
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : undefined;
}

async function main(): Promise<void> {
  // Backfill mode: re-emit today's carried-forward magazine prices right now
  // (run-less snapshot → immediately client-visible). No AI cost, no scraping.
  if (process.argv.includes('--carry-forward')) {
    const carry = await carryForwardRevistaPrices();
    logger.info({ carry }, 'revista carry-forward complete');
    process.exit(0);
  }

  const onlySuper = getArg('super');
  const force = process.argv.includes('--force');
  const pageSelection = parsePages();
  const skipSeries = parseSeriesList('skip-series');
  const onlySeries = parseSeriesList('only-series');
  const pdfUrl = getArg('url');
  const label = getArg('label');
  const seriesOverride = getArg('series');

  const opts: ProcessOptions = {
    scrapeRunId: null,
    force,
    ...(pageSelection ? { pageSelection } : {}),
    ...(skipSeries ? { skipSeries } : {}),
    ...(onlySeries ? { onlySeries } : {}),
  };

  // Direct PDF ingest: skip discovery, process this one URL through the full
  // pipeline (render → vision → match → review queue).
  if (pdfUrl) {
    if (!onlySuper) {
      logger.error(' --url= requires --super=<id> (e.g. --super=makro)');
      process.exit(1);
    }
    const summary = await ingestPdfUrl(onlySuper, pdfUrl, {
      ...opts,
      ...(label ? { label } : {}),
      ...(seriesOverride ? { seriesKey: seriesOverride } : {}),
    });
    logger.info({ summary }, 'revista url ingest complete');
    process.exit(summary.status === 'failed' ? 1 : 0);
  }

  if (onlySuper) {
    const supers = await loadRevistaSupermarkets();
    const sm = supers.find((s) => s.id === onlySuper);
    if (!sm) {
      logger.error(
        { onlySuper, available: supers.map((s) => s.id) },
        'no such revista supermarket (is config.source_type=revista and is_active=true?)',
      );
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
