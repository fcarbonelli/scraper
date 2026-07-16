/**
 * Read-only audit of the data that feeds the `client_base` export.
 *
 * Answers the question: "why are cells empty in the client export, and which
 * ones can we fill from the client's 211-item reference?" It NEVER writes.
 *
 * It categorizes every active supermarket_products mapping into:
 *   - no_ean         → master product has no EAN at all (can't be matched)
 *   - off_catalog    → has an EAN, but it's NOT in the catalog (built-in ∪ extras)
 *   - needs_seed     → EAN is in the catalog, but the master row is missing one
 *                      or more taxonomy columns (fixable: `npm run db:seed-taxonomy -- --apply`)
 *   - ok             → EAN in catalog AND all 7 taxonomy columns present
 *
 * It also flags supermarkets missing Provincia / Zona (geography blanks) and,
 * optionally, reports today's price coverage (rows with no price).
 *
 * Usage (PowerShell-safe — call tsx directly):
 *   npx tsx --env-file=.env scripts/audit-client-base.ts
 *   npx tsx --env-file=.env scripts/audit-client-base.ts --prices   # also today's price coverage
 */

import { db } from '../src/shared/db.js';
import { getCatalogEans } from '../src/shared/catalog.js';
import { isBuiltInEan } from '../src/shared/catalog.js';

/** The 7 columns the export reads off the master product row. */
const TAXONOMY_FIELDS = [
  'category',
  'subcategory',
  'manufacturer',
  'brand',
  'format',
  'variety',
  'description_forms',
] as const;

// `format` and `variety` are legitimately empty for some catalog items, so a
// blank there is NOT a gap. These four must always be present for a catalog EAN.
const REQUIRED_FIELDS = ['category', 'subcategory', 'manufacturer', 'brand'] as const;

interface ProductRow {
  id: string;
  ean: string | null;
  name: string | null;
  category: string | null;
  subcategory: string | null;
  manufacturer: string | null;
  brand: string | null;
  format: string | null;
  variety: string | null;
  description_forms: string | null;
}

interface SmpRow {
  id: string;
  supermarket_id: string;
  product_id: string;
  is_active: boolean;
  lifecycle_status: string | null;
}

interface SupermarketRow {
  id: string;
  name: string;
  provincia: string | null;
  zona: string | null;
  canal: string | null;
  cadena_display_name: string | null;
  is_active: boolean;
}

/** Generic pager: pull every row from a table past Supabase's 1000-row cap. */
async function fetchAll<T>(table: string, columns: string, order = 'id'): Promise<T[]> {
  const pageSize = 1000;
  const all: T[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await db
      .from(table)
      .select(columns)
      .order(order, { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    const rows = (data ?? []) as unknown as T[];
    all.push(...rows);
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

type Bucket = 'no_ean' | 'off_catalog' | 'needs_seed' | 'ok';

async function main(): Promise<void> {
  const withPrices = process.argv.slice(2).includes('--prices');

  const [catalog, products, mappings, supermarkets] = await Promise.all([
    getCatalogEans(),
    fetchAll<ProductRow>(
      'products',
      'id, ean, name, category, subcategory, manufacturer, brand, format, variety, description_forms',
    ),
    fetchAll<SmpRow>('supermarket_products', 'id, supermarket_id, product_id, is_active, lifecycle_status'),
    fetchAll<SupermarketRow>(
      'supermarkets',
      'id, name, provincia, zona, canal, cadena_display_name, is_active',
    ),
  ]);

  const productById = new Map(products.map((p) => [p.id, p]));
  const smById = new Map(supermarkets.map((s) => [s.id, s]));

  // --- 1. Geography blanks (active chains only) -----------------------------
  const geoGaps = supermarkets
    .filter((s) => s.is_active)
    .filter((s) => !s.provincia || !s.zona || !s.canal)
    .map((s) => ({
      id: s.id,
      name: s.name,
      provincia: s.provincia ?? '(vacío)',
      zona: s.zona ?? '(vacío)',
      canal: s.canal ?? '(vacío)',
    }));

  // --- 2. Bucket every ACTIVE mapping ---------------------------------------
  interface ChainStat {
    id: string;
    name: string;
    active: number;
    no_ean: number;
    off_catalog: number;
    needs_seed: number;
    ok: number;
  }
  const perChain = new Map<string, ChainStat>();
  const offCatalogEans = new Map<string, { ean: string; name: string; chains: Set<string> }>();
  const needsSeedSamples: string[] = [];
  // Distinct catalog EANs (with source) whose master row is missing a required
  // column — split by whether they come from the built-in 211 or the extras list.
  const needsSeedEans = new Map<string, { ean: string; builtin: boolean; missing: string[] }>();

  function classify(prod: ProductRow | undefined): Bucket {
    if (!prod || !prod.ean) return 'no_ean';
    const inCatalog = catalog.has(prod.ean);
    if (!inCatalog) return 'off_catalog';
    for (const f of REQUIRED_FIELDS) {
      if (!prod[f]) return 'needs_seed';
    }
    return 'ok';
  }

  const activeMappings = mappings.filter((m) => m.is_active);
  for (const m of activeMappings) {
    const sm = smById.get(m.supermarket_id);
    if (!sm) continue;
    let stat = perChain.get(m.supermarket_id);
    if (!stat) {
      stat = { id: sm.id, name: sm.name, active: 0, no_ean: 0, off_catalog: 0, needs_seed: 0, ok: 0 };
      perChain.set(m.supermarket_id, stat);
    }
    stat.active++;

    const prod = productById.get(m.product_id);
    const bucket = classify(prod);
    stat[bucket]++;

    if (bucket === 'off_catalog' && prod?.ean) {
      const entry = offCatalogEans.get(prod.ean) ?? {
        ean: prod.ean,
        name: prod.name ?? '',
        chains: new Set<string>(),
      };
      entry.chains.add(sm.id);
      offCatalogEans.set(prod.ean, entry);
    }
    if (bucket === 'needs_seed' && prod?.ean) {
      const missing = REQUIRED_FIELDS.filter((f) => !prod[f]);
      if (!needsSeedEans.has(prod.ean)) {
        needsSeedEans.set(prod.ean, { ean: prod.ean, builtin: isBuiltInEan(prod.ean), missing });
      }
      if (needsSeedSamples.length < 25) {
        const src = isBuiltInEan(prod.ean) ? 'built-in' : 'EXTRA';
        needsSeedSamples.push(`  ${prod.ean}  ${src.padEnd(9)} ${sm.id.padEnd(16)} missing[${missing.join(',')}]  ${prod.name ?? ''}`);
      }
    }
  }

  // --- 3. Totals ------------------------------------------------------------
  const totals = { active: 0, no_ean: 0, off_catalog: 0, needs_seed: 0, ok: 0 };
  for (const s of perChain.values()) {
    totals.active += s.active;
    totals.no_ean += s.no_ean;
    totals.off_catalog += s.off_catalog;
    totals.needs_seed += s.needs_seed;
    totals.ok += s.ok;
  }

  // Catalog-level facts.
  const builtIn = Array.from(catalog.keys()).filter((e) => isBuiltInEan(e)).length;
  const extras = catalog.size - builtIn;

  // --- Report ---------------------------------------------------------------
  const line = '='.repeat(78);
  console.log(`\n${line}\nCLIENT_BASE DATA AUDIT (read-only)\n${line}`);
  console.log(`Catalog EANs: ${catalog.size}  (built-in ${builtIn} + runtime extras ${extras})`);
  console.log(`Products in DB: ${products.length}   Active mappings: ${totals.active}`);

  console.log(`\n--- Taxonomy columns (why text cells are blank) ---`);
  console.log(`  ok           ${String(totals.ok).padStart(5)}  EAN in catalog + all required columns present`);
  console.log(`  needs_seed   ${String(totals.needs_seed).padStart(5)}  EAN in catalog but master row missing columns  → db:seed-taxonomy --apply`);
  console.log(`  off_catalog  ${String(totals.off_catalog).padStart(5)}  has EAN, NOT in the 211 reference               → match/add EAN`);
  console.log(`  no_ean       ${String(totals.no_ean).padStart(5)}  master product has no EAN                        → heal:eans / rediscover`);

  console.log(`\n--- Geography blanks (active chains missing Provincia/Zona/Canal) ---`);
  if (geoGaps.length === 0) {
    console.log('  none — all active chains have Provincia/Zona/Canal');
  } else {
    for (const g of geoGaps) {
      console.log(`  ${g.id.padEnd(20)} prov=${g.provincia}  zona=${g.zona}  canal=${g.canal}`);
    }
  }

  console.log(`\n--- Per-chain breakdown (active mappings) ---`);
  console.log(`  ${'chain'.padEnd(20)} ${'act'.padStart(4)} ${'ok'.padStart(4)} ${'seed'.padStart(4)} ${'offc'.padStart(4)} ${'noEAN'.padStart(5)}`);
  for (const s of [...perChain.values()].sort((a, b) => (b.needs_seed + b.off_catalog + b.no_ean) - (a.needs_seed + a.off_catalog + a.no_ean))) {
    console.log(`  ${s.id.padEnd(20)} ${String(s.active).padStart(4)} ${String(s.ok).padStart(4)} ${String(s.needs_seed).padStart(4)} ${String(s.off_catalog).padStart(4)} ${String(s.no_ean).padStart(5)}`);
  }

  // How many of the needs_seed EANs are built-in (fixable via seed-taxonomy)
  // vs from the extras list (fix the catalog_extra_eans row itself).
  const nsBuiltIn = [...needsSeedEans.values()].filter((e) => e.builtin).length;
  const nsExtra = needsSeedEans.size - nsBuiltIn;
  console.log(`\n--- 'needs_seed' distinct EANs: ${needsSeedEans.size}  (built-in ${nsBuiltIn}, EXTRA ${nsExtra}) ---`);
  console.log(`  built-in → 'db:seed-taxonomy --apply' fills them; EXTRA → the catalog_extra_eans row is itself incomplete.`);
  if (needsSeedSamples.length) {
    console.log(needsSeedSamples.join('\n'));
  }

  // --- Extras list completeness (the "second list" beyond the 211) ----------
  const { data: extraRows, error: extraErr } = await db
    .from('catalog_extra_eans')
    .select('ean, description_forms, category, subcategory, brand, manufacturer, format, variety');
  if (extraErr) throw extraErr;
  const extrasList = (extraRows ?? []) as {
    ean: string; description_forms: string | null; category: string | null;
    subcategory: string | null; brand: string | null; manufacturer: string | null;
  }[];
  const incompleteExtras = extrasList.filter(
    (r) => !r.category || !r.subcategory || !r.brand || !r.manufacturer,
  );
  console.log(`\n--- catalog_extra_eans (the second/manual list): ${extrasList.length} rows, ${incompleteExtras.length} incomplete ---`);
  for (const r of incompleteExtras) {
    const missing = (['category', 'subcategory', 'brand', 'manufacturer'] as const).filter((f) => !r[f]);
    console.log(`  ${r.ean}  missing[${missing.join(',')}]  brand=${r.brand ?? '∅'}  ${r.description_forms ?? ''}`);
  }

  if (offCatalogEans.size) {
    const list = [...offCatalogEans.values()].sort((a, b) => b.chains.size - a.chains.size);
    console.log(`\n--- Off-catalog EANs (${offCatalogEans.size} distinct — NOT in the 211 reference) ---`);
    console.log(`(These need either an EAN correction on the product, or an entry in catalog_extra_eans.)`);
    for (const e of list.slice(0, 40)) {
      console.log(`  ${e.ean}  [${e.chains.size} chain(s)]  ${e.name}`);
    }
    if (list.length > 40) console.log(`  … and ${list.length - 40} more`);
  }

  // --- 4. Optional: today's price coverage ----------------------------------
  if (withPrices) {
    // Buenos Aires day window (UTC-3, no DST).
    const now = new Date();
    const ba = new Date(now.getTime() - 3 * 3600_000);
    const dayStart = new Date(Date.UTC(ba.getUTCFullYear(), ba.getUTCMonth(), ba.getUTCDate(), 3, 0, 0));
    const iso = dayStart.toISOString();

    // Page past the 1000-row cap so the counts are real, not truncated.
    const rows: { status: string | null; price: number | null }[] = [];
    const pageSize = 1000;
    let offset = 0;
    for (;;) {
      const { data, error } = await db
        .from('price_snapshots')
        .select('status, price, scraped_at')
        .gte('scraped_at', iso)
        .order('id', { ascending: true })
        .range(offset, offset + pageSize - 1);
      if (error) throw error;
      const batch = (data ?? []) as { status: string | null; price: number | null }[];
      rows.push(...batch);
      if (batch.length < pageSize) break;
      offset += pageSize;
    }
    const byStatus = new Map<string, number>();
    let noPrice = 0;
    for (const r of rows) {
      const st = r.status ?? 'ok';
      byStatus.set(st, (byStatus.get(st) ?? 0) + 1);
      if (r.price == null) noPrice++;
    }
    console.log(`\n--- Today's price snapshots (since ${iso}) ---`);
    console.log(`  total ${rows.length}   without a price ${noPrice}`);
    for (const [st, n] of [...byStatus.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${st.padEnd(16)} ${String(n).padStart(6)}`);
    }
  }

  console.log(`\n${line}\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
