/**
 * Revista diagnostics — answer "why is nothing showing up?" without spending a
 * cent on AI. READ-ONLY + cheap discovery only (no vision, no matching, no
 * Playwright downloads). Run on the server (or locally against the same DB):
 *
 *   npm run revistas:doctor
 *
 * It reports, per magazine-sourced chain:
 *   1. Is it configured + active? (config.source_type='revista')
 *   2. Does cheap discovery find the current issue(s)? (URL + fingerprint hash)
 *   3. For each discovered issue: is there already a DB row for that hash, and
 *      what STATUS is it in? ('processing' = crashed mid-run and stuck;
 *      'in_review' = should be visible in the frontend; 'reviewed' = done)
 *   4. Global tallies of revista_magazines / revista_review_items.
 *
 * The output tells you immediately whether the problem is detection (no
 * candidates), processing (stuck in 'processing'), matching (0 items), or purely
 * frontend (rows are 'in_review' with items but the UI shows nothing).
 */

import { db } from '../src/shared/db.js';
import { revistaConfig } from '../src/revistas/config.js';
import {
  loadRevistaSupermarkets,
  type RevistaSupermarket,
} from '../src/revistas/pipeline.js';
import { discoverCandidates } from '../src/revistas/sources.js';
import { findMagazineByHash } from '../src/revistas/store.js';

/* eslint-disable no-console */

function line(): void {
  console.log('─'.repeat(72));
}

async function magazineTally(): Promise<void> {
  const { data, error } = await db
    .from('revista_magazines')
    .select('id, supermarket_id, label, status, page_count, scrape_run_id, detected_at, metadata')
    .order('detected_at', { ascending: false });
  if (error) throw error;
  const mags = data ?? [];

  line();
  console.log(`revista_magazines: ${mags.length} row(s) total`);
  const byStatus: Record<string, number> = {};
  for (const m of mags) byStatus[m.status] = (byStatus[m.status] ?? 0) + 1;
  console.log('  by status:', byStatus);

  for (const m of mags) {
    const { count } = await db
      .from('revista_review_items')
      .select('id', { count: 'exact', head: true })
      .eq('magazine_id', m.id);
    const meta = (m.metadata ?? {}) as {
      matched?: number;
      total?: number;
      page_images?: Array<{ page: number; url: string }>;
    };
    const imgs = meta.page_images?.length ?? 0;
    console.log(
      `  • [${m.status}] ${m.supermarket_id} — "${m.label}" — pages=${m.page_count} ` +
        `items=${count ?? 0} matched=${meta.matched ?? '?'}/${meta.total ?? '?'} imgs=${imgs} ` +
        `detected=${m.detected_at} id=${m.id}`,
    );
    if (imgs > 0 && meta.page_images) console.log(`      img[0]=${meta.page_images[0]?.url}`);
  }
}

async function checkSupermarket(sm: RevistaSupermarket): Promise<void> {
  line();
  console.log(`CHAIN: ${sm.id} (${sm.name}) — strategy=${sm.strategy.strategy}`);
  console.log(`  offersUrl=${sm.strategy.offersUrl ?? '(none)'} pubhtml5Url=${sm.strategy.pubhtml5Url ?? '(none)'}`);
  try {
    const candidates = await discoverCandidates(sm.strategy);
    if (candidates.length === 0) {
      console.log('  ⚠️  DISCOVERY FOUND 0 ISSUES — detection is broken (site changed, URL wrong, or geo-blocked).');
      return;
    }
    console.log(`  ✓ discovered ${candidates.length} issue(s):`);
    for (const c of candidates) {
      const existing = await findMagazineByHash(sm.id, c.hash);
      const state = existing ? `DB row status='${existing.status}'` : 'NOT in DB yet (never processed)';
      console.log(`    - "${c.label}"`);
      console.log(`      url=${c.sourceUrl}`);
      console.log(`      hash=${c.hash} → ${state}`);
    }
  } catch (err) {
    console.log(`  ❌ DISCOVERY THREW: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Catalog stats — a tiny catalog (or one with no brands) explains 0 matches. */
async function catalogStats(): Promise<void> {
  line();
  const total = await db.from('products').select('id', { count: 'exact', head: true });
  const withBrand = await db
    .from('products')
    .select('id', { count: 'exact', head: true })
    .not('brand', 'is', null);
  const withEan = await db
    .from('products')
    .select('id', { count: 'exact', head: true })
    .not('ean', 'is', null);
  console.log(
    `catalog (products): total=${total.count ?? '?'} withBrand=${withBrand.count ?? '?'} withEan=${withEan.count ?? '?'}`,
  );
  const { data: sample } = await db.from('products').select('name, brand').limit(8);
  for (const p of sample ?? []) console.log(`  e.g. brand=${p.brand ?? '∅'} | ${p.name}`);
}

async function main(): Promise<void> {
  const quick = process.argv.includes('--quick');
  console.log('REVISTA DOCTOR');
  line();
  console.log(`REVISTA_ENABLED   = ${revistaConfig.enabled}`);
  console.log(`OPENAI_API_KEY    = ${revistaConfig.openaiApiKey ? 'set' : 'MISSING (pipeline skips!)'}`);
  console.log(`storage bucket    = ${revistaConfig.storageBucket}`);
  console.log(`match threshold   = ${revistaConfig.matchThreshold}`);

  await catalogStats();

  const supers = await loadRevistaSupermarkets();
  line();
  if (supers.length === 0) {
    console.log('⚠️  0 magazine-sourced supermarkets found.');
    console.log('    Either the code with the revista seed was never deployed, or `npm run db:setup`');
    console.log('    was not run. A revista chain needs is_active=true AND');
    console.log("    config->>source_type = 'revista'. Checking raw config for the known ids...");
    const { data } = await db
      .from('supermarkets')
      .select('id, is_active, config')
      .in('id', ['makro', 'vital', 'rosental', 'maxicomodin']);
    for (const row of data ?? []) {
      console.log(`    - ${row.id}: is_active=${row.is_active} config=${JSON.stringify(row.config)}`);
    }
  } else {
    console.log(`Found ${supers.length} magazine-sourced chain(s): ${supers.map((s) => s.id).join(', ')}`);
    if (quick) {
      console.log('(--quick: skipping live discovery)');
    } else {
      for (const sm of supers) await checkSupermarket(sm);
    }
  }

  await magazineTally();
  line();
  console.log('Done.');
  process.exit(0);
}

main().catch((err) => {
  console.error('doctor failed:', err);
  process.exit(1);
});
