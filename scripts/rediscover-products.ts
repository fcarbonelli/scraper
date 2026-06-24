/**
 * Re-discovery "healer" for products whose external_id went stale.
 *
 * WHY THIS EXISTS
 * ---------------
 * Some chains (La Anónima is the motivating case) periodically REPLACE a
 * product's article id: the EAN stays the same but the on-site `art_<id>` (our
 * `external_id` / `external_url`) changes. The old PDP then 302s to the
 * homepage, so the daily scrape throws `selector_failed` (no Product JSON-LD)
 * or `product_not_found` — every single day, forever, until someone re-maps it.
 *
 * The EAN is the stable identifier, so we can self-heal: for each recently
 * FAILED product, re-run the adapter's `searchByEan()` to find the *current*
 * article, then update the `supermarket_products` row IN PLACE. Updating in
 * place (rather than inserting a new row) preserves `product_id` and therefore
 * the price-history lineage in `price_snapshots`.
 *
 * This is intentionally a separate, on-demand script (like discover-products),
 * NOT part of the scrape hot path: adapters have no DB access by design, and a
 * re-map is a discovery concern, not a scrape concern.
 *
 * SAFE BY DEFAULT
 * ---------------
 * Runs as a DRY RUN unless you pass `--apply`. Dry run prints exactly what it
 * WOULD change so you can eyeball the EAN→new-URL matches first.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/rediscover-products.ts la-anonima
 *   npx tsx --env-file=.env scripts/rediscover-products.ts la-anonima --apply
 *
 * Options:
 *   --apply                Actually write changes (default: dry run).
 *   --since-hours=N        Look back this many hours for failures (default 96).
 *   --delay=N              Milliseconds between EAN searches (default 1200).
 *   --limit=N              Only process the first N candidates (for testing).
 *   --error-types=a,b      Failure error_types that mark a "stale" product
 *                          (default: selector_failed,product_not_found,region_unavailable).
 *   --deactivate-missing   For products whose EAN no longer resolves at all
 *                          (truly discontinued), set is_active=false so they
 *                          stop failing daily. Off by default.
 */

import { db, fetchInChunks } from '../src/shared/db.js';
import { getAdapter } from '../src/adapters/registry.js';
import { logger } from '../src/shared/logger.js';

// Error types that mean "the URL/article is gone", i.e. worth re-resolving.
// Transient errors (network_timeout, rate_limited, …) are deliberately excluded
// — those recover on their own and shouldn't trigger a re-map.
const DEFAULT_STALE_TYPES = ['selector_failed', 'product_not_found', 'region_unavailable'];

interface Candidate {
  supermarketProductId: string;
  externalId: string;
  externalUrl: string | null;
  productId: string;
}

interface Args {
  supermarketId: string;
  apply: boolean;
  sinceHours: number;
  delay: number;
  limit: number | null;
  staleTypes: string[];
  deactivateMissing: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined =>
    argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  const supermarketId = argv.filter((a) => !a.startsWith('--'))[0] ?? 'la-anonima';
  return {
    supermarketId,
    apply: argv.includes('--apply'),
    sinceHours: Number(flag('since-hours') ?? '96'),
    delay: Number(flag('delay') ?? '1200'),
    limit: flag('limit') ? Number(flag('limit')) : null,
    staleTypes: (flag('error-types') ?? DEFAULT_STALE_TYPES.join(',')).split(',').filter(Boolean),
    deactivateMissing: argv.includes('--deactivate-missing'),
  };
}

/**
 * Build the candidate set: products that FAILED recently with a stale-type
 * error and did NOT also succeed in the same window (so we skip ones that
 * already recovered on a later attempt).
 */
async function loadCandidates(args: Args): Promise<Candidate[]> {
  const since = new Date(Date.now() - args.sinceHours * 3600_000).toISOString();

  // Failed jobs with a stale-type error for this supermarket.
  const failedRes = await db
    .from('job_executions')
    .select(
      'error_type, supermarket_product_id, supermarket_products!inner(id, supermarket_id, external_id, external_url, product_id, is_active)',
    )
    .eq('status', 'failed')
    .in('error_type', args.staleTypes)
    .gte('finished_at', since)
    .eq('supermarket_products.supermarket_id', args.supermarketId)
    .limit(10000);
  if (failedRes.error) throw failedRes.error;

  // Products that succeeded in the same window (so we can exclude recoveries).
  const okRes = await db
    .from('job_executions')
    .select('supermarket_product_id, supermarket_products!inner(supermarket_id)')
    .eq('status', 'success')
    .gte('finished_at', since)
    .eq('supermarket_products.supermarket_id', args.supermarketId)
    .limit(20000);
  if (okRes.error) throw okRes.error;
  const recovered = new Set(
    (okRes.data ?? []).map((r) => r.supermarket_product_id as string),
  );

  const byId = new Map<string, Candidate>();
  for (const row of failedRes.data ?? []) {
    const sp = Array.isArray(row.supermarket_products)
      ? row.supermarket_products[0]
      : row.supermarket_products;
    if (!sp || sp.is_active === false) continue;
    const id = sp.id as string;
    if (recovered.has(id) || byId.has(id)) continue;
    byId.set(id, {
      supermarketProductId: id,
      externalId: sp.external_id as string,
      externalUrl: (sp.external_url as string | null) ?? null,
      productId: sp.product_id as string,
    });
  }
  return [...byId.values()];
}

/** Fetch EAN (+ name for logging) for the candidate product_ids. */
async function loadEans(productIds: string[]): Promise<Map<string, { ean: string | null; name: string }>> {
  const rows = await fetchInChunks(productIds, (chunk) =>
    db.from('products').select('id, ean, name').in('id', chunk),
  );
  const out = new Map<string, { ean: string | null; name: string }>();
  for (const r of rows as Array<{ id: string; ean: string | null; name: string }>) {
    out.set(r.id, { ean: r.ean, name: r.name });
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const args = parseArgs();
  const adapter = getAdapter(args.supermarketId);
  if (!adapter.searchByEan) {
    console.error(`Adapter "${args.supermarketId}" has no searchByEan(); cannot re-discover.`);
    process.exit(1);
  }

  logger.info(
    {
      supermarket: args.supermarketId,
      apply: args.apply,
      sinceHours: args.sinceHours,
      staleTypes: args.staleTypes,
    },
    `re-discovery starting (${args.apply ? 'APPLY' : 'DRY RUN'})`,
  );

  let candidates = await loadCandidates(args);
  if (args.limit) candidates = candidates.slice(0, args.limit);
  const eans = await loadEans(candidates.map((c) => c.productId));

  const tally = {
    remapped: [] as string[],
    superseded: [] as string[],
    stillListed: [] as string[],
    missing: [] as string[],
    deactivated: [] as string[],
    noEan: [] as string[],
    errors: [] as string[],
  };

  console.log(`\nFound ${candidates.length} stale candidate(s) for ${args.supermarketId}.\n`);

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    const meta = eans.get(c.productId);
    const ean = meta?.ean?.replace(/\D/g, '') ?? '';
    const label = `[${i + 1}/${candidates.length}] ${meta?.name ?? c.productId}`;

    if (!ean) {
      tally.noEan.push(c.supermarketProductId);
      console.log(`${label}\n  SKIP no-ean (current ${c.externalId})`);
      continue;
    }

    let found: { url: string; externalId?: string } | null = null;
    try {
      found = await adapter.searchByEan(ean);
    } catch (err) {
      tally.errors.push(c.supermarketProductId);
      console.log(`${label}\n  ERROR search failed: ${(err as Error).message}`);
      if (args.delay > 0) await sleep(args.delay);
      continue;
    }

    if (!found) {
      tally.missing.push(c.supermarketProductId);
      console.log(`${label}\n  MISSING ean ${ean} resolves to nothing (discontinued?)`);
      if (args.deactivateMissing && args.apply) {
        const { error } = await db
          .from('supermarket_products')
          .update({ is_active: false })
          .eq('id', c.supermarketProductId);
        if (error) {
          tally.errors.push(c.supermarketProductId);
          console.log(`  ! deactivate failed: ${error.message}`);
        } else {
          tally.deactivated.push(c.supermarketProductId);
          console.log(`  -> deactivated (is_active=false)`);
        }
      }
      if (args.delay > 0) await sleep(args.delay);
      continue;
    }

    const newExternalId = found.externalId ?? null;
    if (newExternalId && newExternalId === c.externalId) {
      // Search resolves to the same article we already have — the daily failure
      // is therefore NOT a stale-id problem (could be transient, or a sucursal
      // availability gap). Leave it alone.
      tally.stillListed.push(c.supermarketProductId);
      console.log(`${label}\n  STILL-LISTED ${c.externalId} (not a stale-id case; left as-is)`);
      if (args.delay > 0) await sleep(args.delay);
      continue;
    }

    // A different (or newly-resolved) article id — this is a re-map.
    console.log(
      `${label}\n  REMAP ean ${ean}: ${c.externalId} -> ${newExternalId ?? '(url-only)'}\n        ${found.url}`,
    );

    if (!args.apply) {
      tally.remapped.push(c.supermarketProductId);
      if (args.delay > 0) await sleep(args.delay);
      continue;
    }

    // Guard against the (supermarket_id, external_id) unique constraint: if a
    // live row for the NEW id already exists, don't collide — just deactivate
    // the dead row so it stops failing (the live row already tracks the price).
    let collision: { id: string } | null = null;
    if (newExternalId) {
      const existing = await db
        .from('supermarket_products')
        .select('id')
        .eq('supermarket_id', args.supermarketId)
        .eq('external_id', newExternalId)
        .neq('id', c.supermarketProductId)
        .maybeSingle();
      if (existing.error) {
        tally.errors.push(c.supermarketProductId);
        console.log(`  ! collision check failed: ${existing.error.message}`);
        continue;
      }
      collision = (existing.data as { id: string } | null) ?? null;
    }

    if (collision) {
      const { error } = await db
        .from('supermarket_products')
        .update({ is_active: false })
        .eq('id', c.supermarketProductId);
      if (error) {
        tally.errors.push(c.supermarketProductId);
        console.log(`  ! deactivate-on-collision failed: ${error.message}`);
      } else {
        tally.superseded.push(c.supermarketProductId);
        console.log(`  -> new id already tracked by ${collision.id}; deactivated dead row`);
      }
    } else {
      const update: Record<string, unknown> = { external_url: found.url };
      if (newExternalId) update.external_id = newExternalId;
      const { error } = await db
        .from('supermarket_products')
        .update(update)
        .eq('id', c.supermarketProductId);
      if (error) {
        tally.errors.push(c.supermarketProductId);
        console.log(`  ! update failed: ${error.message}`);
      } else {
        tally.remapped.push(c.supermarketProductId);
        console.log(`  -> remapped in place`);
      }
    }

    if (args.delay > 0) await sleep(args.delay);
  }

  console.log(`\n=== Re-discovery ${args.apply ? 'APPLIED' : '(dry run)'} for ${args.supermarketId} ===`);
  console.log(`  Candidates:        ${candidates.length}`);
  console.log(`  Re-mapped:         ${tally.remapped.length}`);
  console.log(`  Superseded:        ${tally.superseded.length}`);
  console.log(`  Still-listed:      ${tally.stillListed.length}`);
  console.log(`  Missing (gone):    ${tally.missing.length}`);
  console.log(`  Deactivated:       ${tally.deactivated.length}`);
  console.log(`  No EAN (skipped):  ${tally.noEan.length}`);
  console.log(`  Errors:            ${tally.errors.length}`);
  if (!args.apply && tally.remapped.length > 0) {
    console.log(`\n  Re-run with --apply to write the ${tally.remapped.length} re-map(s).`);
  }
  process.exit(0);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
