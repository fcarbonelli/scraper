/**
 * Reconcile the MercadoLibre product list to ECOMODICO-only.
 *
 * WHY
 * ---
 * We track MercadoLibre solely for the seller "ECOMODICO". Our list was
 * originally discovered by EAN against the whole catalog, so it can contain
 * catalog products Ecomodico doesn't sell. For every active ML mapping this
 * script checks Ecomodico's own offer and:
 *
 *   - Ecomodico sells it  -> KEEP, and pin `external_url` to Ecomodico's own
 *     listing (`/p/<catalogId>?item_id=<itemId>`). Without the pin the catalog
 *     page shows the cheapest seller (usually NOT Ecomodico), which looks like
 *     we're tracking another supplier even though the price we record is
 *     Ecomodico's.
 *   - Ecomodico doesn't sell it (or catalog gone) -> DEACTIVATE.
 *
 * The check is the exact same one the adapter uses at scrape time
 * (`fetchEcomodicoOffer` → `/products/<id>/items?seller_id=<ecomodico>`), so
 * "kept" here == "scrapeable" later. Never deletes rows, never touches other
 * supermarkets, never re-activates anything. Safe to re-run.
 *
 * Usage (PowerShell-safe — invoke tsx directly; npm eats the `--` flags):
 *   npx tsx --env-file=.env scripts/prune-ecomodico.ts            # dry-run report
 *   npx tsx --env-file=.env scripts/prune-ecomodico.ts --apply    # write changes
 *   npx tsx --env-file=.env scripts/prune-ecomodico.ts --apply --limit=50
 */

import { db } from '../src/shared/db.js';
import { logger } from '../src/shared/logger.js';
import { fetchEcomodicoOffer, ecomodicoListingUrl } from '../src/adapters/mercadolibre.js';

const REQUEST_DELAY_MS = 300; // be gentle with the ML API

interface MlMapping {
  id: string;
  externalId: string;
  externalUrl: string | null;
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
    .select('id, external_id, external_url')
    .eq('supermarket_id', 'mercadolibre')
    .eq('is_active', true);
  if (limit) q = q.limit(limit);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []).map((r) => ({
    id: r.id as string,
    externalId: r.external_id as string,
    externalUrl: (r.external_url as string) ?? null,
  }));
}

async function main(): Promise<void> {
  const { apply, limit } = parseFlags(process.argv.slice(2));
  logger.info({ apply, limit }, `Ecomodico reconcile starting${apply ? '' : ' (DRY RUN)'}`);

  const mappings = await loadActiveMlMappings(limit);
  logger.info(`Found ${mappings.length} active MercadoLibre mapping(s).`);

  let kept = 0;
  let errors = 0;
  const deactivateIds: string[] = [];
  const urlUpdates: Array<{ id: string; url: string }> = [];

  for (let i = 0; i < mappings.length; i++) {
    const m = mappings[i]!;
    const tag = `[${i + 1}/${mappings.length}] ${m.externalId}`;
    try {
      const offer = await fetchEcomodicoOffer(m.externalId, undefined);
      if (offer) {
        kept += 1;
        const pinned = ecomodicoListingUrl(m.externalId, offer.itemId);
        if (m.externalUrl !== pinned) {
          urlUpdates.push({ id: m.id, url: pinned });
          logger.info(`${tag} KEEP  ($${offer.price})  pin-url -> ${pinned}`);
        } else {
          logger.info(`${tag} KEEP  ($${offer.price})  url ok`);
        }
      } else {
        deactivateIds.push(m.id);
        logger.info(`${tag} DROP  (no Ecomodico offer)`);
      }
    } catch (err) {
      // Transient API errors (429/5xx/timeout): skip, don't change anything.
      errors += 1;
      logger.warn({ err: (err as Error).message }, `${tag} SKIP (error — left unchanged)`);
    }
    await sleep(REQUEST_DELAY_MS);
  }

  if (apply) {
    if (deactivateIds.length > 0) {
      const { error } = await db
        .from('supermarket_products')
        .update({ is_active: false })
        .in('id', deactivateIds);
      if (error) throw error;
    }
    // URL updates are per-row (each URL differs).
    for (const u of urlUpdates) {
      const { error } = await db
        .from('supermarket_products')
        .update({ external_url: u.url })
        .eq('id', u.id);
      if (error) throw error;
    }
  }

  logger.info(
    {
      apply,
      total: mappings.length,
      kept,
      deactivated: apply ? deactivateIds.length : `${deactivateIds.length} (would)`,
      urls_pinned: apply ? urlUpdates.length : `${urlUpdates.length} (would)`,
      errors,
    },
    `=== Ecomodico reconcile ${apply ? 'complete' : '(dry run)'} ===`,
  );
  if (!apply && (deactivateIds.length > 0 || urlUpdates.length > 0)) {
    logger.info('Re-run with --apply to deactivate non-Ecomodico products and pin listing URLs.');
  }
}

void main().catch((e) => {
  logger.error({ err: e }, 'Ecomodico reconcile failed');
  process.exitCode = 1;
});
