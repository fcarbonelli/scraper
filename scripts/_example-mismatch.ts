// TEMP: show the full story of one EAN-mismatch example. Delete after.
import { db } from '../src/shared/db.js';

// Two barcodes that appear to be the same physical product (Lysoform Floral 1.8L).
const CLIENT_EAN = '7790520995216'; // client's master list
const OUR_EAN = '7790520028457';    // what the scraper stored

async function show(ean: string, label: string): Promise<void> {
  console.log(`\n=== ${label}: EAN ${ean} ===`);
  const { data: prods } = await db.from('products').select('id, ean, name, brand, category, created_at').eq('ean', ean);
  if (!prods || prods.length === 0) { console.log('  (no product row with this EAN)'); return; }
  for (const p of prods) {
    console.log(`  product ${p.id}`);
    console.log(`    name="${p.name}" brand="${p.brand}" created=${p.created_at?.slice(0, 10)}`);
    const { data: maps } = await db.from('supermarket_products')
      .select('supermarket_id, is_active, external_id, created_at').eq('product_id', p.id).order('supermarket_id');
    console.log(`    mappings (${maps?.length ?? 0}):`);
    for (const m of maps ?? []) console.log(`      ${m.supermarket_id.padEnd(16)} active=${m.is_active} extId=${m.external_id} created=${m.created_at?.slice(0, 10)}`);
  }
}

async function main(): Promise<void> {
  await show(CLIENT_EAN, 'CLIENT master EAN');
  await show(OUR_EAN, 'SCRAPER-stored EAN');
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
