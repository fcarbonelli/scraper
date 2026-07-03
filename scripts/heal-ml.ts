/**
 * Heal MercadoLibre "Unknown product" masters (name/brand backfill).
 *
 * WHY
 * ---
 * A large batch of MercadoLibre mappings sit on master rows whose name is the
 * literal "Unknown product" with no brand. Root cause: at ingest time the ML
 * metadata probe failed (no OAuth token yet), so nothing was persisted — and
 * ML's catalog API does NOT expose a GTIN/EAN for these consumer-goods products
 * (verified: neither the catalog product nor its seller items carry one), so the
 * EAN was never recoverable from ML directly.
 *
 * What IS recoverable now (the token works): a clean product name + brand from
 * the catalog API `/products/<id>`. Backfilling those turns opaque
 * "Unknown product" rows into real, matchable names — which then lets the
 * existing text/LLM EAN matcher (`scripts/heal-eans.ts`) bind an official EAN
 * for the ones that are in our catalog.
 *
 * This script does ONLY the deterministic half: name + brand backfill. Run the
 * EAN matcher afterwards.
 *
 * Usage (PowerShell-safe — invoke tsx directly, npm eats the `--` flags):
 *   npx tsx --env-file=.env scripts/heal-ml.ts            # dry-run report
 *   npx tsx --env-file=.env scripts/heal-ml.ts --apply    # write name/brand
 *   npx tsx --env-file=.env scripts/heal-ml.ts --apply --limit=50
 */

import { db } from '../src/shared/db.js';
import { logger } from '../src/shared/logger.js';
import { mercadolibreAdapter } from '../src/adapters/mercadolibre.js';
import type { ScrapeContext } from '../src/adapters/types.js';

const UNKNOWN = 'Unknown product';
const REQUEST_DELAY_MS = 400; // be gentle with the ML API

interface Orphan {
  smpId: string;
  productId: string;
  externalId: string;
  externalUrl: string | null;
  currentName: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Master rows are "unknown" when name is null/empty or the sentinel. */
function isUnknownName(name: string | null): boolean {
  const n = (name ?? '').trim();
  return n === '' || n.toLowerCase() === UNKNOWN.toLowerCase();
}

/** Load MercadoLibre mappings whose master still has no real name. */
async function loadOrphans(): Promise<Orphan[]> {
  const { data, error } = await db
    .from('supermarket_products')
    .select('id, product_id, external_id, external_url, products:product_id ( name )')
    .eq('supermarket_id', 'mercadolibre')
    .limit(2000);
  if (error) throw error;

  const out: Orphan[] = [];
  for (const r of data ?? []) {
    const p = Array.isArray(r.products) ? r.products[0] : r.products;
    const name = (p?.name as string | undefined) ?? null;
    if (!isUnknownName(name)) continue;
    out.push({
      smpId: r.id as string,
      productId: r.product_id as string,
      externalId: (r.external_id as string) ?? '',
      externalUrl: (r.external_url as string) ?? null,
      currentName: name,
    });
  }
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const limitArg = args.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1] ?? '', 10) || Infinity : Infinity;

  const orphans = (await loadOrphans()).slice(0, limit);
  console.log(
    `MercadoLibre masters needing a name: ${orphans.length}` +
      (apply ? '  (APPLYING)' : '  (dry-run — pass --apply to write)') +
      '\n',
  );

  let named = 0;
  let branded = 0;
  let noData = 0;
  let updated = 0;

  for (const o of orphans) {
    const ctx = {
      supermarketProductId: o.smpId,
      externalId: o.externalId,
      externalUrl: o.externalUrl,
      logger,
      signal: undefined,
    } as ScrapeContext;

    let name: string | undefined;
    let brand: string | undefined;
    try {
      const info = await mercadolibreAdapter.probe!(ctx);
      name = info.name;
      brand = info.brand;
    } catch (err) {
      console.log(`${o.externalId.padEnd(14)} ERROR: ${(err as Error).message}`);
      await sleep(REQUEST_DELAY_MS);
      continue;
    }

    if (!name) {
      noData++;
      console.log(`${o.externalId.padEnd(14)} (API returned no name — skipped)`);
      await sleep(REQUEST_DELAY_MS);
      continue;
    }

    named++;
    if (brand) branded++;
    console.log(`${o.externalId.padEnd(14)} brand=${(brand ?? '—').padEnd(14)} ${name}`);

    if (apply) {
      const patch: Record<string, unknown> = { name };
      if (brand) patch.brand = brand;
      const { error } = await db.from('products').update(patch).eq('id', o.productId);
      if (error) {
        console.log(`   ! update failed: ${error.message}`);
      } else {
        updated++;
      }
    }

    await sleep(REQUEST_DELAY_MS);
  }

  console.log(
    `\nDone. ${named} got a name (${branded} with brand), ${noData} had no API name.` +
      (apply ? ` ${updated} master rows updated.` : ' (dry-run — nothing written)'),
  );
  if (apply && updated > 0) {
    console.log('\nNext: run the EAN matcher on the freshly-named rows:');
    console.log('  npx tsx --env-file=.env scripts/heal-eans.ts --judge');
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
