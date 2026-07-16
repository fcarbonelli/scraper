/**
 * Fill the missing `manufacturer` on catalog_extra_eans rows whose `brand` is a
 * known brand in the client's brand→manufacturer map (src/shared/taxonomy.ts).
 *
 * The built-in 211 already carry manufacturers; only the runtime "extras" (the
 * second, manually-added list) sometimes have a brand but no Fabricante. This
 * fills exactly the ones we can derive with certainty and leaves the rest for
 * the client to classify (see scripts/export-to-complete.ts).
 *
 * After running this with --apply, run `npm run db:seed-taxonomy -- --apply`
 * (or `npx tsx --env-file=.env scripts/seed-taxonomy.ts --apply`) to propagate
 * the new manufacturer onto the master `products` rows the export reads.
 *
 * Idempotent. Dry-run by default.
 *   npx tsx --env-file=.env scripts/fill-extra-fabricante.ts
 *   npx tsx --env-file=.env scripts/fill-extra-fabricante.ts --apply
 */

import { db } from '../src/shared/db.js';
import { MARCA_TO_FABRICANTE } from '../src/shared/taxonomy.js';

interface ExtraRow {
  ean: string;
  brand: string | null;
  manufacturer: string | null;
  description_forms: string | null;
}

async function main(): Promise<void> {
  const apply = process.argv.slice(2).includes('--apply');

  const { data, error } = await db
    .from('catalog_extra_eans')
    .select('ean, brand, manufacturer, description_forms');
  if (error) throw error;
  const rows = (data ?? []) as ExtraRow[];

  const fillable: { ean: string; brand: string; manufacturer: string }[] = [];
  const unresolved: ExtraRow[] = [];

  for (const r of rows) {
    if (r.manufacturer) continue; // already set
    const brandKey = r.brand?.trim().toUpperCase();
    const man = brandKey ? MARCA_TO_FABRICANTE[brandKey] : undefined;
    if (man) fillable.push({ ean: r.ean, brand: r.brand!, manufacturer: man });
    else unresolved.push(r);
  }

  console.log(`\ncatalog_extra_eans rows: ${rows.length}`);
  console.log(`Derivable Fabricante from brand map: ${fillable.length}`);
  for (const f of fillable) console.log(`  ${f.ean}  ${f.brand}  →  ${f.manufacturer}`);

  if (unresolved.length) {
    console.log(`\nStill missing Fabricante (brand not in map — needs client input): ${unresolved.length}`);
    for (const u of unresolved) {
      console.log(`  ${u.ean}  brand=${u.brand ?? '∅'}  ${u.description_forms ?? ''}`);
    }
  }

  if (apply) {
    let ok = 0;
    for (const f of fillable) {
      const { error: upErr } = await db
        .from('catalog_extra_eans')
        .update({ manufacturer: f.manufacturer })
        .eq('ean', f.ean);
      if (upErr) {
        console.error(`  update failed for ${f.ean}:`, upErr.message);
        continue;
      }
      ok++;
    }
    console.log(`\nApplied: ${ok}/${fillable.length} rows updated.`);
    console.log(`Next: propagate to master rows → npx tsx --env-file=.env scripts/seed-taxonomy.ts --apply`);
  } else if (fillable.length) {
    console.log(`\nDry-run — re-run with --apply to write.`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
