/**
 * Probe whether specific (supermarket, EAN) pairs can be found & priced.
 *
 * READ-ONLY. For each pair it reports, in order:
 *   1. catalog status  — is the EAN in the client's 211+extras catalog?
 *   2. current mapping  — do we already have this product at this chain?
 *        · active   → already in the export (client's "missing" list is stale)
 *        · paused   → we have the URL but it's deactivated (just reactivate)
 *   3. live search      — if not mapped, call the adapter's searchByEan(); when a
 *      hit comes back we immediately scrape it so you see the actual PRICE + URL.
 *
 * Nothing is written to the DB — this only tells you what's out there so you can
 * decide what to ingest/reactivate.
 *
 * INPUT: a text file of lines "supermarket: ean, ean, ..." (# comments allowed),
 * e.g.
 *     atomo: 7791234567890, 7790000000000
 *     carrefour: 7791234567890
 * Supermarket can be the id (atomo) or display name (MAXI CARREFOUR).
 *
 * A results CSV is written (default: alongside the input file, or Downloads) with
 * one row per (supermarket, EAN): status, price, url — easy to hand back.
 *
 *   npx tsx --env-file=.env scripts/probe-coverage.ts <list.txt>
 *   npx tsx --env-file=.env scripts/probe-coverage.ts <list.txt> --out "C:\path\out.csv"
 *   npx tsx --env-file=.env scripts/probe-coverage.ts            # runs a built-in sample
 */

import { db } from '../src/shared/db.js';
import { logger } from '../src/shared/logger.js';
import { getAdapter } from '../src/adapters/registry.js';
import { getCatalogEans } from '../src/shared/catalog.js';
import type { ScrapeContext, SupermarketConfig } from '../src/adapters/types.js';
import { readFileSync, writeFileSync } from 'node:fs';

// Fallback sample (the user's first batch) when no file is passed.
const SAMPLE = `
atomo: 779238908132, 7798270247142, 8480017240699
california: 7791905023210, 7792389080744, 7792389081321
carrefour: 7791905023210, 7798270247142, 8480017240699
`;

interface SupRow {
  id: string; name: string; base_url: string | null;
  rate_limit_ms: number; concurrency: number; config: Record<string, unknown> | null;
  cadena_display_name: string | null; is_active: boolean;
}

/** Parse "name: ean, ean" lines into { supKey, eans } groups. */
function parsePairs(text: string): { supKey: string; eans: string[] }[] {
  const out: { supKey: string; eans: string[] }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split('#')[0]!.trim();
    if (!line || !line.includes(':')) continue;
    const [name, rest] = line.split(/:(.*)/s);
    const eans = (rest ?? '').split(/[,\s]+/).map((e) => e.trim()).filter(Boolean);
    if (name && eans.length) out.push({ supKey: name.trim(), eans });
  }
  return out;
}

function toConfig(s: SupRow): SupermarketConfig {
  return {
    id: s.id, name: s.name, baseUrl: s.base_url,
    rateLimitMs: s.rate_limit_ms, concurrency: s.concurrency,
    config: s.config ?? {},
  };
}

/** One result row, collected for the summary + CSV. */
interface Result {
  supermarket: string; ean: string; catalog: string;
  status: string; price: string; url: string;
}
const results: Result[] = [];

function csvCell(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const file = args.find((a) => !a.startsWith('--'));
  const text = file ? readFileSync(file, 'utf8') : SAMPLE;
  const outPath = outIdx >= 0 && args[outIdx + 1]
    ? args[outIdx + 1]!
    : (file ? file.replace(/\.[^.]+$/, '') + '_resultado.csv'
            : `C:\\Users\\fran-\\Downloads\\probe_coverage_${new Date().toISOString().slice(0, 10)}.csv`);
  const groups = parsePairs(text);

  const catalog = await getCatalogEans();

  // Resolve supermarket key (id or display name) → row.
  const { data: supsData } = await db
    .from('supermarkets')
    .select('id, name, base_url, rate_limit_ms, concurrency, config, cadena_display_name, is_active');
  const sups = (supsData ?? []) as SupRow[];
  const resolveSup = (key: string): SupRow | undefined => {
    const k = key.toLowerCase().trim();
    const kSlug = k.replace(/\s+/g, '-');
    return sups.find(
      (s) =>
        s.id.toLowerCase() === k ||
        s.id.toLowerCase() === kSlug ||
        (s.name ?? '').toLowerCase() === k ||
        (s.cadena_display_name ?? '').toLowerCase() === k,
    );
  };

  for (const { supKey, eans } of groups) {
    const sup = resolveSup(supKey);
    console.log('\n' + '='.repeat(72));
    if (!sup) {
      console.log(`${supKey}: UNKNOWN SUPERMARKET (no matching row)`);
      for (const ean of eans) results.push({ supermarket: supKey, ean, catalog: '', status: 'unknown_supermarket', price: '', url: '' });
      continue;
    }
    const supName = sup.cadena_display_name ?? sup.name;
    console.log(`${supName} (${sup.id})${sup.is_active ? '' : '  [CHAIN INACTIVE]'}`);
    console.log('='.repeat(72));

    let adapter;
    try { adapter = getAdapter(sup.id); }
    catch {
      console.log('  no adapter registered — cannot search.');
      for (const ean of eans) results.push({ supermarket: supName, ean, catalog: '', status: 'no_adapter', price: '', url: '' });
      continue;
    }
    const canSearch = typeof adapter.searchByEan === 'function';

    for (const ean of eans) {
      const validLen = /^\d{13}$/.test(ean);
      const tax = catalog.get(ean);
      const catNote = tax ? `in-catalog (${tax.category}/${tax.subcategory})` : 'OFF-catalog';
      const lenNote = validLen ? '' : `  ⚠ EAN is ${ean.length} digits (expected 13)`;
      console.log(`\n  EAN ${ean} — ${catNote}${lenNote}`);
      const rec = (status: string, price = '', url = ''): void => {
        results.push({ supermarket: supName, ean, catalog: tax ? 'in-catalog' : 'off-catalog', status, price, url });
      };

      // 2. existing mapping?
      const { data: prods } = await db.from('products').select('id').eq('ean', ean);
      const pids = (prods ?? []).map((p) => p.id as string);
      let mapped = false;
      if (pids.length) {
        const { data: maps } = await db
          .from('supermarket_products')
          .select('id, is_active, external_url')
          .eq('supermarket_id', sup.id)
          .in('product_id', pids);
        for (const m of maps ?? []) {
          mapped = true;
          console.log(`    already mapped: ${m.is_active ? 'ACTIVE (in export)' : 'PAUSED (reactivate to show)'} — ${m.external_url}`);
          rec(m.is_active ? 'already_active' : 'paused', '', m.external_url ?? '');
        }
      }
      if (mapped) continue;

      // 3. live search + scrape for price
      if (!canSearch) { console.log('    no searchByEan on this adapter — needs a manual URL.'); rec('no_search'); continue; }
      try {
        const found = await adapter.searchByEan!(ean);
        if (!found) { console.log('    search: NOT FOUND at this chain.'); rec('not_found'); continue; }
        const externalId = found.externalId
          ?? (adapter.resolveExternalId ? await adapter.resolveExternalId(found.url) : new URL(found.url).pathname);
        const ctx: ScrapeContext = {
          supermarketProductId: 'probe',
          externalId,
          externalUrl: found.url,
          config: toConfig(sup),
          logger: logger.child({ supermarket: sup.id, ean }),
        };
        try {
          const r = await adapter.scrape(ctx);
          console.log(`    FOUND ✓  price=${r.price} ${r.currency} inStock=${r.inStock}  (${r.tierUsed}${r.zoneUsed ? ', zone=' + r.zoneUsed : ''})`);
          console.log(`      url: ${found.url}`);
          rec('found', String(r.price), found.url);
        } catch (err) {
          console.log(`    FOUND (url) but scrape failed: ${(err as Error).message}`);
          console.log(`      url: ${found.url}`);
          rec('found_no_price', '', found.url);
        }
      } catch (err) {
        console.log(`    search error: ${(err as Error).message}`);
        rec('search_error');
      }
    }
  }

  // --- Summary + CSV --------------------------------------------------------
  const counts = new Map<string, number>();
  for (const r of results) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  console.log('\n' + '='.repeat(72));
  console.log(`SUMMARY (${results.length} pairs)`);
  for (const [k, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(20)} ${n}`);

  const header = 'Supermercado,EAN,Catalogo,Estado,Precio,URL';
  const lines = results.map((r) =>
    [r.supermarket, r.ean, r.catalog, r.status, r.price, r.url].map(csvCell).join(','));
  writeFileSync(outPath, '\uFEFF' + [header, ...lines].join('\r\n') + '\r\n', 'utf8');
  console.log(`\nWrote results → ${outPath}`);
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
