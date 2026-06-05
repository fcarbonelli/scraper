/**
 * Adapter smoke / canary harness — the "don't go blind" safety net.
 *
 * Runs adapters end-to-end (scrape → validate) WITHOUT writing to the database,
 * prints a pass/fail table, and exits non-zero if anything is broken. Designed
 * to be run by hand after a change, on a schedule (cron), or in CI so a flaky
 * supermarket is caught in seconds instead of after a full daily run.
 *
 * Two modes:
 *
 *   1. --from-db  (recommended, the real canary)
 *      Picks N active products per active supermarket straight from the DB and
 *      scrapes them. Self-maintaining: as you add supermarkets/products, they're
 *      automatically covered. Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
 *
 *   2. default (no DB)
 *      Scrapes a small curated list of hard-coded product URLs. Useful locally
 *      when you don't have DB creds. Extend CURATED_URLS as needed.
 *
 * Every result is checked with validateScrapeResult() AND its flattened
 * promotion columns are range-checked, so the exact class of bug that nuked
 * Carrefour (a 15% discount overflowing unit_discount numeric(5,4)) is caught
 * here before it can reach Postgres.
 *
 * Usage:
 *   npm run smoke                          # curated URL list, no DB
 *   npm run smoke:db                       # from-db (Windows-friendly; preferred)
 *   npm run smoke -- --from-db             # same, if your shell forwards args
 *   npm run smoke:db -- --limit=3          # three products per supermarket
 *   npm run smoke:db -- --supermarket=carrefour
 *   npm run smoke:db -- --skip=maxi-carrefour
 *   npm run smoke -- --timeout=45000       # per-product timeout (ms)
 *
 * On Windows/PowerShell, `npm run smoke -- --from-db` often does NOT forward
 * flags to the script (you'll see mode:"curated" in the log). Use `smoke:db`
 * instead, or set SMOKE_FROM_DB=1.
 */

import { logger } from '../src/shared/logger.js';
import { getAdapter } from '../src/adapters/registry.js';
import { detectSupermarket } from '../src/ingest/index.js';
import { validateScrapeResult } from '../src/adapters/validate.js';
import { flattenPromotions } from '../src/worker/promotions.js';
import type {
  ScrapeContext,
  ScrapeResult,
  SupermarketConfig,
} from '../src/adapters/types.js';

/** Curated fallback (DB-free mode). externalId skips live slug→id lookups. */
interface CuratedEntry {
  url: string;
  /** When set, skip adapter.resolveExternalId (avoids Carrefour pagetype 429s). */
  externalId?: string;
}

// maxi-carrefour is intentionally omitted: its scrape can trigger a Playwright
// login, which is too heavy for a quick smoke test (use --from-db for it).
const CURATED_ENTRIES: CuratedEntry[] = [
  {
    url: 'https://www.cotodigital.com.ar/sitios/cdigi/productos/lavandina-original-ayudin-2l/_/R-00591050-00591050-200',
  },
  {
    url: 'https://www.carrefour.com.ar/lavandina-odex-1-l/p',
    externalId: '643943', // VTEX productId — avoids pagetype API during setup
  },
];

const DEFAULT_TIMEOUT_MS = 60_000;

interface CliArgs {
  fromDb: boolean;
  limit: number;
  supermarket: string | null;
  skip: Set<string>;
  timeoutMs: number;
}

/**
 * Extract CLI flags from process.argv. tsx leaves `--env-file=...` and the
 * script path in argv; on Windows, npm may also fail to forward args after `--`.
 */
function getCliArgv(): string[] {
  const raw = process.argv.slice(2);
  const scriptIdx = raw.findIndex((a) =>
    a.replace(/\\/g, '/').includes('smoke-test.ts'),
  );
  if (scriptIdx >= 0) return raw.slice(scriptIdx + 1);
  return raw.filter((a) => a.startsWith('--'));
}

function parseArgs(argv: string[]): CliArgs {
  const get = (name: string): string | undefined =>
    argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  const fromDb =
    argv.includes('--from-db') || process.env.SMOKE_FROM_DB === '1';
  return {
    fromDb,
    limit: Math.max(1, Number(get('limit') ?? '1')),
    supermarket: get('supermarket') ?? null,
    skip: new Set((get('skip') ?? '').split(',').filter(Boolean)),
    timeoutMs: Math.max(1000, Number(get('timeout') ?? String(DEFAULT_TIMEOUT_MS))),
  };
}

interface Target {
  supermarketId: string;
  label: string; // human-readable id for the report (URL or product id)
  ctx: ScrapeContext;
}

interface Outcome {
  supermarketId: string;
  label: string;
  status: 'PASS' | 'WARN' | 'FAIL';
  durationMs: number;
  detail: string;
}

/** Run a single scrape with a hard timeout, then validate the result. */
async function runTarget(t: Target, timeoutMs: number): Promise<Outcome> {
  const adapter = getAdapter(t.supermarketId);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const start = Date.now();

  try {
    const result: ScrapeResult = await adapter.scrape({ ...t.ctx, signal: ac.signal });
    const durationMs = Date.now() - start;

    const { ok, errors, warnings } = validateScrapeResult(result);

    // Belt-and-suspenders: also range-check the flattened promo columns, which
    // is where the unit_discount overflow actually surfaced.
    const flat = flattenPromotions(result.promotions, result.price);
    if (flat.unit_discount != null && Math.abs(flat.unit_discount) >= 10) {
      errors.push(`unit_discount ${flat.unit_discount} would overflow numeric(5,4)`);
    }

    if (errors.length > 0) {
      return {
        supermarketId: t.supermarketId,
        label: t.label,
        status: 'FAIL',
        durationMs,
        detail: errors.join('; '),
      };
    }
    const summary = `price=${result.price} inStock=${result.inStock}${
      result.zoneUsed ? ` zone=${result.zoneUsed}` : ''
    }`;
    return {
      supermarketId: t.supermarketId,
      label: t.label,
      status: warnings.length > 0 ? 'WARN' : 'PASS',
      durationMs,
      detail: warnings.length > 0 ? `${summary} | ${warnings.join('; ')}` : summary,
    };
  } catch (err) {
    return {
      supermarketId: t.supermarketId,
      label: t.label,
      status: 'FAIL',
      durationMs: Date.now() - start,
      detail: ac.signal.aborted ? `timed out after ${timeoutMs}ms` : (err as Error).message,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Build targets from the curated list (no DB). Setup errors become FAIL rows. */
async function buildCuratedTargets(): Promise<{
  targets: Target[];
  setupFailures: Outcome[];
}> {
  const targets: Target[] = [];
  const setupFailures: Outcome[] = [];

  for (const entry of CURATED_ENTRIES) {
    const supermarketId = detectSupermarket(entry.url);
    try {
      const adapter = getAdapter(supermarketId);
      const canonicalUrl = adapter.canonicalizeUrl
        ? adapter.canonicalizeUrl(entry.url)
        : entry.url;
      const externalId =
        entry.externalId ??
        (adapter.resolveExternalId
          ? await adapter.resolveExternalId(canonicalUrl)
          : new URL(canonicalUrl).pathname);
      const config: SupermarketConfig = {
        id: supermarketId,
        name: supermarketId,
        baseUrl: null,
        rateLimitMs: 0,
        concurrency: 1,
        config: {},
      };
      targets.push({
        supermarketId,
        label: entry.url,
        ctx: {
          supermarketProductId: 'smoke-test',
          externalId,
          externalUrl: canonicalUrl,
          config,
          logger: logger.child({ supermarket: supermarketId, externalId }),
        },
      });
    } catch (err) {
      setupFailures.push({
        supermarketId,
        label: entry.url,
        status: 'FAIL',
        durationMs: 0,
        detail: `setup: ${(err as Error).message}`,
      });
    }
  }
  return { targets, setupFailures };
}

/** Build targets from the DB: N active products per active supermarket. */
async function buildDbTargets(args: CliArgs): Promise<Target[]> {
  // Lazy-import DB-dependent modules so curated mode works without DB creds.
  const { db } = await import('../src/shared/db.js');
  const { loadJobInput } = await import('../src/worker/persist.js');

  let smQuery = db.from('supermarkets').select('id,name').eq('is_active', true);
  if (args.supermarket) smQuery = smQuery.eq('id', args.supermarket);
  const { data: supermarkets, error: smErr } = await smQuery;
  if (smErr) throw smErr;

  const targets: Target[] = [];
  for (const sm of supermarkets ?? []) {
    if (args.skip.has(sm.id)) continue;
    const { data: products, error: prodErr } = await db
      .from('supermarket_products')
      .select('id')
      .eq('supermarket_id', sm.id)
      .eq('is_active', true)
      .limit(args.limit);
    if (prodErr) throw prodErr;

    for (const prod of products ?? []) {
      const input = await loadJobInput(prod.id);
      if (!input) continue;
      const { supermarketProduct, supermarket } = input;
      targets.push({
        supermarketId: supermarket.id,
        label: `${supermarket.id}/${supermarketProduct.externalId}`,
        ctx: {
          supermarketProductId: supermarketProduct.id,
          externalId: supermarketProduct.externalId,
          externalUrl: supermarketProduct.externalUrl,
          config: {
            id: supermarket.id,
            name: supermarket.name,
            baseUrl: supermarket.baseUrl,
            rateLimitMs: supermarket.rateLimitMs,
            concurrency: supermarket.concurrency,
            config: supermarket.config,
          },
          logger: logger.child({
            supermarket: supermarket.id,
            externalId: supermarketProduct.externalId,
          }),
        },
      });
    }
  }
  return targets;
}

function printReport(outcomes: Outcome[]): void {
  console.log('\n=== Smoke test report ===');
  const pad = (s: string, n: number): string => s.padEnd(n).slice(0, n);
  console.log(
    `${pad('STATUS', 6)} ${pad('SUPERMARKET', 16)} ${pad('TIME', 8)} TARGET / DETAIL`,
  );
  console.log('-'.repeat(80));
  for (const o of outcomes) {
    console.log(
      `${pad(o.status, 6)} ${pad(o.supermarketId, 16)} ${pad(`${o.durationMs}ms`, 8)} ${o.label}`,
    );
    if (o.detail) console.log(`${' '.repeat(32)}${o.detail}`);
  }

  const pass = outcomes.filter((o) => o.status === 'PASS').length;
  const warn = outcomes.filter((o) => o.status === 'WARN').length;
  const fail = outcomes.filter((o) => o.status === 'FAIL').length;
  console.log('-'.repeat(80));
  console.log(`Total: ${outcomes.length} | PASS: ${pass} | WARN: ${warn} | FAIL: ${fail}\n`);
}

async function main(): Promise<void> {
  const cliArgv = getCliArgv();
  const args = parseArgs(cliArgv);
  logger.info(
    { mode: args.fromDb ? 'from-db' : 'curated', limit: args.limit, cliArgv },
    'starting smoke test',
  );

  try {
    let targets: Target[];
    let setupFailures: Outcome[] = [];
    if (args.fromDb) {
      targets = await buildDbTargets(args);
    } else {
      const curated = await buildCuratedTargets();
      targets = curated.targets;
      setupFailures = curated.setupFailures;
    }

    if (targets.length === 0 && setupFailures.length === 0) {
      logger.warn('no targets to test');
      return;
    }

    // Run sequentially to keep load gentle and output readable; per-product
    // timeout prevents one hung scrape from blocking the whole run.
    const outcomes: Outcome[] = [...setupFailures];
    for (const t of targets) {
      outcomes.push(await runTarget(t, args.timeoutMs));
    }

    printReport(outcomes);

    // Non-zero exit on any failure so CI / cron flags it.
    if (outcomes.some((o) => o.status === 'FAIL')) process.exitCode = 1;
  } catch (err) {
    logger.error({ err }, 'smoke test aborted during setup');
    printReport([
      {
        supermarketId: '-',
        label: 'setup',
        status: 'FAIL',
        durationMs: 0,
        detail: (err as Error).message,
      },
    ]);
    process.exitCode = 1;
  }
}

void main();
