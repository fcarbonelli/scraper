/**
 * Prune the MercadoLibre product list down to ECOMODICO-only.
 *
 * WHY
 * ---
 * We track MercadoLibre solely for the seller "ECOMODICO". Our list was
 * originally discovered by EAN against the whole catalog, so it contains many
 * catalog products Ecomodico doesn't sell. This script checks each active ML
 * mapping against Ecomodico's own offer and DEACTIVATES the ones Ecomodico
 * doesn't sell (or whose catalog product is gone). It never deletes rows or
 * touches other supermarkets, and it never re-activates anything.
 *
 * The check is the exact same one the adapter uses at scrape time
 * (`fetchEcomodicoOffer` → `/products/<id>/items?seller_id=<ecomodico>`), so
 * "kept" here == "scrapeable" later.
 *
 * Usage (PowerShell-safe — invoke tsx directly; npm eats the `--` flags):
 *   npx tsx --env-file=.env scripts/prune-ecomodico.ts            # dry-run report
 *   npx tsx --env-file=.env scripts/prune-ecomodico.ts --apply    # deactivate non-Ecomodico
 *   npx tsx --env-file=.env scripts/prune-ecomodico.ts --apply --limit=50
 */

import { db } from '../src/shared/db.js';
import { logger } from '../src/shared/logger.js';
import { fetchEcomodicoOffer } from '../src/adapters/mercadolibre.js';

const REQUEST_DELAY_MS = 300; // be gentle with the ML API

interface MlMapping {
  id: string;
  externalId: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseFlags(argv: string[]): { apply: boolean; limit: number | null } {
  const apply = argv.includes('--apply');
  let limit: number | null = null;
  for (const a of argv) {
    const m = a.match(/^--limit=(\d+)$/);
    if (m) limit = Number(m[1]);
  }
  return { apply, limit };
}

async function loadActiveMlMappings(limit: number | null): Promise<MlMapping[]> {
  let q = db
    .from('supermarket_products')
    .select('id, external_id')
    .eq('supermarket_id', 'mercadolibre')
    .eq('is_active', true);
  if (limit) q = q.limit(limit);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []).map((r) => ({
    id: r.id as string,
    externalId: r.external_id as string,
  }));
}

async function main(): Promise<void> {
  const { apply, limit } = parseFlags(process.argv.slice(2));
  logger.info({ apply, limit }, `Ecomodico prune starting${apply ? '' : ' (DRY RUN)'}`);

  const mappings = await loadActiveMlMappings(limit);
  logger.info(`Found ${mappings.length} active MercadoLibre mapping(s).`);

  let kept = 0;
  let toDeactivate = 0;
  let errors = 0;
  const deactivateIds: string[] = [];

  for (let i = 0; i < mappings.length; i++) {
    const m = mappings[i]!;
    const tag = `[${i + 1}/${mappings.length}] ${m.externalId}`;
    try {
      const offer = await fetchEcomodicoOffer(m.externalId, undefined);
      if (offer) {
        kept += 1;
        logger.info(`${tag} KEEP  (Ecomodico $${offer.price})`);
      } else {
        toDeactivate += 1;
        deactivateIds.push(m.id);
        logger.info(`${tag} DROP  (no Ecomodico offer)`);
      }
    } catch (err) {
      // Transient API errors (429/5xx/timeout): skip, don't deactivate on a blip.
      errors += 1;
      logger.warn({ err: (err as Error).message }, `${tag} SKIP (error — left active)`);
    }
    await sleep(REQUEST_DELAY_MS);
  }

  // Apply deactivations in one bulk update.
  if (apply && deactivateIds.length > 0) {
    const { error } = await db
      .from('supermarket_products')
      .update({ is_active: false })
      .in('id', deactivateIds);
    if (error) throw error;
  }

  logger.info(
    {
      apply,
      total: mappings.length,
      kept,
      deactivated: apply ? deactivateIds.length : 0,
      would_deactivate: apply ? undefined : toDeactivate,
      errors,
    },
    `=== Ecomodico prune ${apply ? 'complete' : '(dry run)'} ===`,
  );
  if (!apply && toDeactivate > 0) {
    logger.info('Re-run with --apply to deactivate the non-Ecomodico products.');
  }
}

void main().catch((e) => {
  logger.error({ err: e }, 'Ecomodico prune failed');
  process.exitCode = 1;
});
