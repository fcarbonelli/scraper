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
 * NO-EAN PRODUCTS (La Anónima)
 * ----------------------------
 * Some failing rows have no EAN recorded (ingested with placeholder metadata),
 * so EAN search can't help. For La Anónima we fall back to matching the dead
 * product's URL slug against search-result slugs — but this is REVIEW-ONLY and
 * never auto-applied: token+size similarity can't reliably tell varieties apart
 * (OFF "Extra Duración" vs "Family", Raid "cucarachas" vs "mata moscas"), so the
 * script just prints ranked candidates for an operator to confirm by hand.
 *
 * SAFE BY DEFAULT
 * ---------------
 * Runs as a DRY RUN unless you pass `--apply`. Dry run prints exactly what it
 * WOULD change so you can eyeball the EAN→new-URL matches first. (EAN matches
 * are exact; only those are ever auto-applied.)
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
 *
 * Targeted mode (skips the scan; for committing reviewed no-EAN picks):
 *   --map=<smpId>=<newUrl>   Re-map a specific row to a chosen article URL, and
 *                            backfill its master EAN/name from that article so
 *                            it stays healable. Repeatable. Needs --apply.
 *   --retire=<smpId>[,...]   Deactivate rows for genuinely discontinued products
 *                            (no valid replacement). Repeatable. Needs --apply.
 *
 *   e.g.  npm run rediscover -- la-anonima --apply \
 *           --map=<smpId>=https://www.laanonima.com.ar/<slug>/art_3094480/ \
 *           --retire=<smpId-a> --retire=<smpId-b>
 */

import { db, fetchInChunks } from '../src/shared/db.js';
import { getAdapter } from '../src/adapters/registry.js';
import { searchProductCandidates } from '../src/adapters/la-anonima.js';
import { lookupTaxonomy } from '../src/shared/taxonomy.js';
import { logger } from '../src/shared/logger.js';
import type { ProductInfo, ScrapeContext, SupermarketConfig } from '../src/adapters/types.js';

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
  /** Targeted manual re-maps: `--map=<smpId>=<newUrl>` (repeatable). */
  maps: Array<{ smpId: string; url: string }>;
  /** Targeted retirements: `--retire=<smpId>[,<smpId>...]` (repeatable). */
  retire: string[];
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined =>
    argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  const supermarketId = argv.filter((a) => !a.startsWith('--'))[0] ?? 'la-anonima';

  // Targeted re-maps: each `--map=<smpId>=<url>`. We split on the FIRST '=' only
  // (URLs contain no '=', but be safe).
  const maps: Array<{ smpId: string; url: string }> = [];
  for (const a of argv.filter((x) => x.startsWith('--map='))) {
    const rest = a.slice('--map='.length);
    const eq = rest.indexOf('=');
    if (eq > 0) maps.push({ smpId: rest.slice(0, eq), url: rest.slice(eq + 1) });
  }
  const retire = argv
    .filter((x) => x.startsWith('--retire='))
    .flatMap((x) => x.slice('--retire='.length).split(','))
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    supermarketId,
    apply: argv.includes('--apply'),
    sinceHours: Number(flag('since-hours') ?? '96'),
    delay: Number(flag('delay') ?? '1200'),
    limit: flag('limit') ? Number(flag('limit')) : null,
    staleTypes: (flag('error-types') ?? DEFAULT_STALE_TYPES.join(',')).split(',').filter(Boolean),
    deactivateMissing: argv.includes('--deactivate-missing'),
    maps,
    retire,
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

// ---- Slug matching (no-EAN re-discovery fallback, La Anónima) --------------

const SLUG_STOPWORDS = new Set(['de', 'la', 'el', 'para', 'con', 'sin', 'y', 'x', 'en', 'al']);

/** Extract the slug segment ("foo-bar" from "/foo-bar/art_123/"). */
function slugFromUrl(url: string): string | null {
  try {
    const m = new URL(url).pathname.match(/\/([^/]+)\/art_\d+/i);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Meaningful tokens from a slug (lowercased, stopwords + 1-char tokens dropped). */
function slugTokens(slug: string): Set<string> {
  return new Set(
    slug
      .toLowerCase()
      .split('-')
      .filter((t) => t.length > 1 && !SLUG_STOPWORDS.has(t)),
  );
}

/** The size/format token of a slug ("170cc", "900ml", "2.5lt"), or null. */
function slugSize(slug: string): string | null {
  const m = slug
    .toLowerCase()
    .replace(/-/g, ' ')
    .match(/(\d+(?:[.,]\d+)?)\s*-?\s*(cc|ml|lt?|grs?|gr?|kg|kgs|un|u|cm|mts?|mt)\b/);
  if (!m?.[1] || !m[2]) return null;
  return `${m[1].replace(',', '.')}${m[2]}`;
}

/** Jaccard similarity of two token sets (0..1). */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

interface RemapApply {
  status: 'remapped' | 'superseded' | 'error';
  detail: string;
}

/**
 * Apply a re-map: point the dead row at `newUrl`/`newExternalId`. Guards the
 * (supermarket_id, external_id) unique constraint — if a live row already
 * tracks the new id, deactivate the dead row instead of colliding.
 */
async function applyRemap(
  supermarketId: string,
  c: Candidate,
  newUrl: string,
  newExternalId: string | null,
): Promise<RemapApply> {
  let collision: { id: string } | null = null;
  if (newExternalId) {
    const existing = await db
      .from('supermarket_products')
      .select('id')
      .eq('supermarket_id', supermarketId)
      .eq('external_id', newExternalId)
      .neq('id', c.supermarketProductId)
      .maybeSingle();
    if (existing.error) return { status: 'error', detail: existing.error.message };
    collision = (existing.data as { id: string } | null) ?? null;
  }

  if (collision) {
    const { error } = await db
      .from('supermarket_products')
      .update({ is_active: false })
      .eq('id', c.supermarketProductId);
    if (error) return { status: 'error', detail: error.message };
    return { status: 'superseded', detail: `new id already tracked by ${collision.id}; deactivated dead row` };
  }

  const update: Record<string, unknown> = { external_url: newUrl };
  if (newExternalId) update.external_id = newExternalId;
  const { error } = await db
    .from('supermarket_products')
    .update(update)
    .eq('id', c.supermarketProductId);
  if (error) return { status: 'error', detail: error.message };
  return { status: 'remapped', detail: 'remapped in place' };
}

interface Tally {
  remapped: string[];
  superseded: string[];
  stillListed: string[];
  missing: string[];
  deactivated: string[];
  noEan: string[];
  needsReview: string[];
  errors: string[];
}

/**
 * No-EAN fallback (La Anónima): find the replacement article by matching the
 * dead product's URL slug against search-result slugs. Returns true when it
 * produced a verdict (re-map or needs-review), false to fall through to the
 * plain no-ean skip (e.g. search returned nothing).
 */
async function trySlugRemap(
  args: Args,
  c: Candidate,
  label: string,
  tally: Tally,
): Promise<boolean> {
  if (!c.externalUrl) return false;
  const slug = slugFromUrl(c.externalUrl);
  if (!slug) return false;

  let cands;
  try {
    cands = await searchProductCandidates(slug.replace(/-/g, ' '));
  } catch {
    return false;
  }
  if (cands.length === 0) return false;

  const target = slugTokens(slug);
  const targetSize = slugSize(slug);
  const ranked = cands
    .map((cd) => {
      const cs = slugFromUrl(cd.url) ?? '';
      return { cd, cs, score: jaccard(target, slugTokens(cs)), size: slugSize(cs) };
    })
    .filter((r) => r.cs && r.cd.externalId !== c.externalId)
    .sort((a, b) => b.score - a.score);
  if (ranked.length === 0) return false;

  // Name matching is REVIEW-ONLY, never auto-applied. Token+size similarity
  // can't reliably distinguish VARIETY (e.g. OFF "Extra Duración" vs "Family",
  // Raid "cucarachas" vs "mata moscas") — and variety is exactly what matters —
  // so a high token score can still be the wrong product. We surface ranked
  // candidates with their art id + slug for an operator to confirm and re-map
  // by hand (or feed into a targeted apply). Auto-applying here would corrupt
  // the price series with a similarly-named-but-different SKU.
  tally.needsReview.push(c.supermarketProductId);
  console.log(
    `${label}\n  NEEDS-REVIEW smpId=${c.supermarketProductId} current=${c.externalId} ` +
      `(no EAN — pick one, then apply with --map=${c.supermarketProductId}=<url>):`,
  );
  for (const r of ranked.slice(0, 5)) {
    const sizeFlag = targetSize && r.size !== targetSize ? ' (size≠)' : '';
    console.log(`     ${r.score.toFixed(2)} size=${r.size ?? '-'}${sizeFlag}  ${r.cd.externalId}  ${r.cd.url}`);
  }
  return true;
}

/** Load the minimal supermarket_products fields for a targeted op. */
async function loadSmp(
  smpId: string,
): Promise<{ productId: string; externalId: string; externalUrl: string | null } | null> {
  const { data, error } = await db
    .from('supermarket_products')
    .select('product_id, external_id, external_url')
    .eq('id', smpId)
    .maybeSingle();
  if (error) throw error;
  return data
    ? {
        productId: data.product_id as string,
        externalId: data.external_id as string,
        externalUrl: (data.external_url as string | null) ?? null,
      }
    : null;
}

/** Re-scrape a URL purely to extract ProductInfo (EAN/name/etc.) for backfill. */
async function probeInfo(
  supermarketId: string,
  url: string,
  externalId: string,
): Promise<ProductInfo> {
  const adapter = getAdapter(supermarketId);
  const config: SupermarketConfig = {
    id: supermarketId,
    name: supermarketId,
    baseUrl: null,
    rateLimitMs: 0,
    concurrency: 1,
    config: {},
  };
  const ctx: ScrapeContext = {
    supermarketProductId: 'rediscover',
    externalId,
    externalUrl: url,
    config,
    logger: logger.child({ supermarket: supermarketId, externalId }),
  };
  if (adapter.probe) return adapter.probe(ctx);
  return (await adapter.scrape(ctx)).productInfo ?? {};
}

/**
 * Backfill the master products row from a freshly-scraped article: fill the EAN
 * (+ client taxonomy) and a real name when they're currently missing, so the
 * product can be healed by EAN if its article id is ever replaced again.
 * Returns the list of fields changed.
 */
async function backfillMaster(productId: string, info: ProductInfo): Promise<string[]> {
  const cur = await db.from('products').select('ean, name').eq('id', productId).maybeSingle();
  if (cur.error || !cur.data) return [];
  const update: Record<string, unknown> = {};
  const changed: string[] = [];

  const ean = info.ean?.replace(/\D/g, '') ?? '';
  if (ean && !cur.data.ean) {
    update.ean = ean;
    changed.push('ean');
    const tax = lookupTaxonomy(ean);
    if (tax) {
      update.category = tax.category;
      update.subcategory = tax.subcategory;
      update.manufacturer = tax.manufacturer;
      update.brand = tax.brand;
      update.format = tax.format || null;
      update.variety = tax.variety || null;
      update.description_forms = tax.descriptionForms || null;
      changed.push('taxonomy');
    }
  }
  if (info.name && (!cur.data.name || cur.data.name === 'Unknown product')) {
    update.name = info.name;
    changed.push('name');
  }
  if (changed.length === 0) return [];

  const { error } = await db.from('products').update(update).eq('id', productId);
  if (error) {
    // Most likely an EAN unique-constraint collision (another product already
    // owns this EAN). Retry without the EAN so at least the name lands.
    if (update.ean) {
      delete update.ean;
      const retry = await db.from('products').update(update).eq('id', productId);
      if (retry.error) throw new Error(retry.error.message);
      return changed.filter((c) => c !== 'ean' && c !== 'taxonomy');
    }
    throw new Error(error.message);
  }
  return changed;
}

/**
 * Targeted mode: apply explicit `--map`/`--retire` operations from a reviewed
 * candidate list. Runs instead of the scan when either flag is present.
 */
async function runTargeted(args: Args): Promise<void> {
  console.log(
    `\nTargeted re-discovery for ${args.supermarketId} (${args.apply ? 'APPLY' : 'DRY RUN'}): ` +
      `${args.maps.length} map(s), ${args.retire.length} retire(s)\n`,
  );
  const adapter = getAdapter(args.supermarketId);

  for (const m of args.maps) {
    const smp = await loadSmp(m.smpId);
    if (!smp) {
      console.log(`MAP ${m.smpId}: row NOT FOUND`);
      continue;
    }
    const canonical = adapter.canonicalizeUrl ? adapter.canonicalizeUrl(m.url) : m.url;
    let newId: string;
    try {
      newId = adapter.resolveExternalId
        ? await adapter.resolveExternalId(canonical)
        : new URL(canonical).pathname;
    } catch (e) {
      console.log(`MAP ${m.smpId}: bad url — ${(e as Error).message}`);
      continue;
    }
    console.log(`MAP ${m.smpId}: ${smp.externalId} -> ${newId}\n        ${canonical}`);
    if (!args.apply) continue;

    const applied = await applyRemap(
      args.supermarketId,
      { supermarketProductId: m.smpId, externalId: smp.externalId, externalUrl: smp.externalUrl, productId: smp.productId },
      canonical,
      newId,
    );
    console.log(`  -> ${applied.status === 'error' ? '! ' + applied.detail : applied.detail}`);
    if (applied.status === 'error') continue;

    // Best-effort: backfill the master EAN/name so it stays healable in future.
    try {
      const info = await probeInfo(args.supermarketId, canonical, newId);
      const changed = await backfillMaster(smp.productId, info);
      if (changed.length) console.log(`  -> backfilled master (${changed.join(', ')})`);
    } catch (e) {
      console.log(`  (master backfill skipped: ${(e as Error).message})`);
    }
  }

  for (const id of args.retire) {
    console.log(`RETIRE ${id}`);
    if (!args.apply) continue;
    const { error } = await db
      .from('supermarket_products')
      .update({ is_active: false })
      .eq('id', id);
    console.log(error ? `  ! ${error.message}` : '  -> deactivated (is_active=false)');
  }

  if (!args.apply) console.log('\n(dry run — re-run with --apply to write)');
}

async function main(): Promise<void> {
  const args = parseArgs();
  const adapter = getAdapter(args.supermarketId);
  if (!adapter.searchByEan) {
    console.error(`Adapter "${args.supermarketId}" has no searchByEan(); cannot re-discover.`);
    process.exit(1);
  }

  // Targeted mode: explicit operator-reviewed re-maps / retirements.
  if (args.maps.length > 0 || args.retire.length > 0) {
    await runTargeted(args);
    process.exit(0);
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
    needsReview: [] as string[],
    errors: [] as string[],
  };

  const canSlugMatch = args.supermarketId === 'la-anonima';

  console.log(`\nFound ${candidates.length} stale candidate(s) for ${args.supermarketId}.\n`);

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    const meta = eans.get(c.productId);
    const ean = meta?.ean?.replace(/\D/g, '') ?? '';
    const label = `[${i + 1}/${candidates.length}] ${meta?.name ?? c.productId}`;

    if (!ean) {
      // No EAN to search by. For La Anónima we can still recover the replacement
      // article via slug matching: the product's URL slug is its full
      // description, as is every search result's URL, so we match slug↔slug with
      // a hard size check to avoid grabbing a different-sized SKU.
      if (canSlugMatch && c.externalUrl) {
        const handled = await trySlugRemap(args, c, label, tally);
        if (handled) {
          if (args.delay > 0) await sleep(args.delay);
          continue;
        }
      }
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

    const applied = await applyRemap(args.supermarketId, c, found.url, newExternalId);
    tally[applied.status === 'error' ? 'errors' : applied.status].push(c.supermarketProductId);
    console.log(`  -> ${applied.status === 'error' ? '! ' + applied.detail : applied.detail}`);

    if (args.delay > 0) await sleep(args.delay);
  }

  console.log(`\n=== Re-discovery ${args.apply ? 'APPLIED' : '(dry run)'} for ${args.supermarketId} ===`);
  console.log(`  Candidates:        ${candidates.length}`);
  console.log(`  Re-mapped:         ${tally.remapped.length}`);
  console.log(`  Superseded:        ${tally.superseded.length}`);
  console.log(`  Still-listed:      ${tally.stillListed.length}`);
  console.log(`  Missing (gone):    ${tally.missing.length}`);
  console.log(`  Deactivated:       ${tally.deactivated.length}`);
  console.log(`  Needs review:      ${tally.needsReview.length}`);
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
