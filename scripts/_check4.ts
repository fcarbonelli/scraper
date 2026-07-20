// TEMP: check the 4 'ADD' candidates' existing mappings. Delete after.
import { db } from '../src/shared/db.js';

const CASES: { sup: string; needle: string; clientEan: string }[] = [
  { sup: 'coto', needle: '00520546', clientEan: '7790520995216' },
  { sup: 'el-abastecedor', needle: 'mortimer', clientEan: '7793253000516' },
  { sup: 'lacoopeencasa', needle: '311857', clientEan: '7791905023203' },
  { sup: 'maxiconsumo', needle: '17062', clientEan: '7791130002240' },
];

async function main(): Promise<void> {
  for (const c of CASES) {
    console.log(`\n=== ${c.sup}  (client EAN ${c.clientEan}) ===`);
    const { data } = await db.from('supermarket_products')
      .select('id, external_id, is_active, external_url, products(ean, name)')
      .eq('supermarket_id', c.sup);
    const rows = (data ?? []) as unknown as { external_id: string; is_active: boolean; external_url: string | null; products: { ean: string | null; name: string } | null }[];
    const hits = rows.filter((r) => (r.external_id ?? '').toLowerCase().includes(c.needle.toLowerCase()) || (r.external_url ?? '').toLowerCase().includes(c.needle.toLowerCase()));
    if (hits.length === 0) { console.log('  no existing mapping matches — genuinely absent'); continue; }
    for (const h of hits) {
      const sameEan = h.products?.ean === c.clientEan;
      console.log(`  extId=${h.external_id} active=${h.is_active} ean=${h.products?.ean} ${sameEan ? '(== client EAN)' : '(DIFFERENT ean)'} name="${h.products?.name}"`);
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
