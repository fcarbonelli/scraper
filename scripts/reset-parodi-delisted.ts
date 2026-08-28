/**
 * Reset erroneously "delisted" (Discontinuado) mappings back to active.
 *
 * Context: the DIPA/Parodi adapter used to treat EVERY PrestaShop redirect as
 * `product_not_found` (fixed in src/adapters/parodi.ts). Live products whose
 * stored URL had merely drifted to a new canonical URL were reported missing
 * every day, and some were then hand-flagged `lifecycle_status='delisted'`,
 * so they now publish as "Discontinuado" for the client even though they're
 * alive. With the adapter fixed, those mappings should scrape normally again —
 * this script flips them back to `active` so the daily run decides their real
 * state (price / out_of_stock / not_found) instead of a stale delist marker.
 *
 * Read-only by default (lists what WOULD change); pass --apply to write.
 *
 * Usage (use `npx tsx` directly — PowerShell drops `--` in `npm run … -- <flags>`):
 *   npx tsx --env-file=.env scripts/reset-parodi-delisted.ts [--supermarket=parodi] [--apply]
 */

import { db } from '../src/shared/db.js';
import { logger } from '../src/shared/logger.js';

function argVal(name: string): string | undefined {
  const pref = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : undefined;
}

const supermarketId = argVal('supermarket') ?? 'parodi';
const apply = process.argv.includes('--apply');

interface Row {
  id: string;
  external_url: string | null;
  lifecycle_note: string | null;
  products: { ean: string | null; name: string | null } | Array<{ ean: string | null; name: string | null }> | null;
}

function firstJoined<T>(v: T | T[] | null | undefined): T | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

async function main(): Promise<void> {
  console.log(
    `Parodi delist-reset | supermarket=${supermarketId} | ` +
      `mode=${apply ? 'APPLY (writes updates)' : 'dry-run (report only)'}`,
  );

  const { data, error } = await db
    .from('supermarket_products')
    .select('id, external_url, lifecycle_note, products:product_id ( ean, name )')
    .eq('supermarket_id', supermarketId)
    .eq('lifecycle_status', 'delisted');
  if (error) throw error;

  const rows = (data ?? []) as unknown as Row[];
  if (rows.length === 0) {
    console.log(`\nNo mappings with lifecycle_status='delisted' at "${supermarketId}". Nothing to do.`);
    return;
  }

  console.log(`\nFound ${rows.length} delisted mapping(s):`);
  for (const r of rows.slice(0, 50)) {
    const p = firstJoined(r.products);
    console.log(
      `  ${r.id}  EAN ${p?.ean ?? '—'}  ${p?.name ?? ''}`.slice(0, 110) +
        (r.external_url ? `\n      ${r.external_url}` : ''),
    );
  }
  if (rows.length > 50) console.log(`  … and ${rows.length - 50} more`);

  if (!apply) {
    console.log('\nRe-run with --apply to set these back to lifecycle_status=active.');
    return;
  }

  const ids = rows.map((r) => r.id);
  const { error: updErr, count } = await db
    .from('supermarket_products')
    .update(
      {
        lifecycle_status: 'active',
        lifecycle_note: 'auto-reset after DIPA canonical-redirect fix',
        lifecycle_changed_at: new Date().toISOString(),
      },
      { count: 'exact' },
    )
    .in('id', ids);
  if (updErr) throw updErr;

  console.log(`\nReset ${count ?? ids.length} mapping(s) to active. Next scrape will re-evaluate them.`);
}

void main().catch((err) => {
  logger.error({ err }, 'reset-parodi-delisted failed');
  process.exitCode = 1;
});
