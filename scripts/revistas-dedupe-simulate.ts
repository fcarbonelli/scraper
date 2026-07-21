/**
 * Offline simulator for revista dedup / EAN-collision rules.
 *
 * Reads fixture rows (no DB, no Docker) and prints what the pure helpers
 * would decide — keep, drop, or flag as a human-review collision.
 *
 * Usage:
 *   npx tsx scripts/revistas-dedupe-simulate.ts
 *   npx tsx scripts/revistas-dedupe-simulate.ts path/to/cases.json
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  findEanCollisions,
  losersAmongDuplicates,
  pickWinnerAmongDuplicates,
  type DedupCandidate,
  type EanCollisionRow,
} from '../src/revistas/pricing.js';

/* eslint-disable no-console */

interface CaseRow extends DedupCandidate, EanCollisionRow {
  name?: string | null;
}

interface CaseFile {
  label: string;
  kind: 'real_duplicate' | 'ean_collision' | string;
  rows: CaseRow[];
}

function loadCases(path: string): CaseFile[] {
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw) as CaseFile[];
}

function main(): void {
  const fixturePath = resolve(
    process.argv[2] ?? 'examples/revistas/dedupe-cases.json',
  );
  const cases = loadCases(fixturePath);

  console.log(`\nREVISTA DEDUPE SIMULATOR (offline — no DB)`);
  console.log(`fixture: ${fixturePath}`);
  console.log(`cases: ${cases.length}\n`);

  for (const c of cases) {
    console.log('─'.repeat(72));
    console.log(`CASE: ${c.label}`);
    console.log(`kind: ${c.kind}`);
    for (const r of c.rows) {
      console.log(
        `  • id=${r.id} ean=${r.ean} product=${r.product_id} price=${r.price} ` +
          `promo=${r.promotion_1 ?? '∅'} name=${r.name ?? ''}`,
      );
    }

    const collisions = findEanCollisions(c.rows);
    if (collisions.length > 0) {
      console.log('  → DECISION: EAN COLLISION (do NOT auto-delete)');
      for (const g of collisions) {
        console.log(
          `     ean=${g.ean} chain=${g.supermarket_id} day=${g.day} products=[${g.product_ids.join(', ')}]`,
        );
        console.log('     action: surface in control view for rematch / EAN fix');
      }
      continue;
    }

    // Group by (ean, supermarket, day, product_id) — real duplicates share product_id.
    const byProduct = new Map<string, CaseRow[]>();
    for (const r of c.rows) {
      const key = `${r.ean}|${r.supermarket_id}|${r.day}|${r.product_id}`;
      const list = byProduct.get(key) ?? [];
      list.push(r);
      byProduct.set(key, list);
    }

    let anyDup = false;
    for (const [, group] of byProduct) {
      if (group.length < 2) continue;
      anyDup = true;
      const winner = pickWinnerAmongDuplicates(group);
      const losers = losersAmongDuplicates(group);
      console.log(
        `  → DECISION: REAL DUPLICATE — keep id=${winner?.id} (price=${winner?.price}, promo=${winner?.promotion_1 ?? '∅'})`,
      );
      console.log(
        `     drop ids=[${losers.map((l) => l.id).join(', ')}]  (rule: offer wins, else newest)`,
      );
    }
    if (!anyDup) {
      console.log('  → DECISION: nothing to collapse (single row per product)');
    }
  }

  console.log('─'.repeat(72));
  console.log('Done.\n');
}

main();
