/**
 * Soft-reset a revista chain for re-testing the review UI WITHOUT re-scanning.
 *
 * Keeps magazines + already-extracted review items (AI cost = 0). For approved
 * items: clears today's (and carry-forward) run-less revista snapshots so they
 * drop out of client_base, resets the item to `pending`, and pauses the
 * resulting mapping when no other approved item points at it. Magazines are
 * left / put back into `in_review`.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/reset-revista-chain.ts --super=rosental --dry-run
 *   npx tsx --env-file=.env scripts/reset-revista-chain.ts --super=rosental
 */

import { db } from '../src/shared/db.js';
import { buenosAiresDate } from '../src/revistas/pricing.js';

/* eslint-disable no-console */

function getArg(name: string): string | undefined {
  const pref = `--${name}=`;
  return process.argv.find((a) => a.startsWith(pref))?.slice(pref.length);
}

async function main(): Promise<void> {
  const supermarketId = getArg('super');
  if (!supermarketId) {
    console.error('Usage: --super=<id> [--dry-run]');
    process.exit(1);
  }
  const dryRun = process.argv.includes('--dry-run');

  console.log(`\nRESET REVISTA CHAIN — ${supermarketId}${dryRun ? ' (DRY-RUN)' : ''}\n`);

  // 1. Magazines for this chain.
  const { data: mags, error: magErr } = await db
    .from('revista_magazines')
    .select('id, label, status, series_key, superseded_by')
    .eq('supermarket_id', supermarketId);
  if (magErr) throw magErr;
  const magazineIds = (mags ?? []).map((m) => m.id as string);
  console.log(`Magazines: ${magazineIds.length}`);
  for (const m of mags ?? []) {
    console.log(
      `  • [${m.status}] series=${m.series_key ?? '?'} ${m.superseded_by ? 'SUPERSEDED' : 'CURRENT'} — "${m.label}"`,
    );
  }
  if (magazineIds.length === 0) {
    console.log('Nothing to reset.');
    process.exit(0);
  }

  // 2. Approved items → pending.
  const { data: approved, error: apErr } = await db
    .from('revista_review_items')
    .select('id, resulting_supermarket_product_id, resulting_snapshot_id, status')
    .in('magazine_id', magazineIds)
    .eq('status', 'approved');
  if (apErr) throw apErr;
  const approvedItems = approved ?? [];
  console.log(`\nApproved items to reset: ${approvedItems.length}`);

  const spIds = [
    ...new Set(
      approvedItems
        .map((i) => i.resulting_supermarket_product_id as string | null)
        .filter((id): id is string => Boolean(id)),
    ),
  ];

  // 3. Collect run-less revista snapshots to delete (approval + carry-forward chain).
  const toDelete = new Set<number>();
  for (const item of approvedItems) {
    if (item.resulting_snapshot_id != null) toDelete.add(item.resulting_snapshot_id as number);
  }

  for (const spId of spIds) {
    const { data, error } = await db
      .from('price_snapshots')
      .select('id, scraped_at, raw_data')
      .eq('supermarket_product_id', spId)
      .is('scrape_run_id', null);
    if (error) throw error;
    for (const row of data ?? []) {
      const raw = row.raw_data as { source?: string; from_snapshot_id?: number } | null;
      const src = raw?.source;
      if (src && src !== 'revista' && src !== 'revista-carry-forward') continue;
      toDelete.add(row.id as number);
    }
  }

  console.log(`Snapshots to delete (run-less revista): ${toDelete.size}`);
  console.log(`Mappings that may be paused: ${spIds.length}`);

  if (dryRun) {
    console.log('\nDRY-RUN — no writes. Re-run without --dry-run to apply.\n');
    process.exit(0);
  }

  // 4. Delete snapshots.
  if (toDelete.size > 0) {
    const { error } = await db.from('price_snapshots').delete().in('id', [...toDelete]);
    if (error) throw error;
  }

  // 5. Reset approved items → pending.
  if (approvedItems.length > 0) {
    const { error } = await db
      .from('revista_review_items')
      .update({
        status: 'pending',
        reviewed_by: null,
        reviewed_at: null,
        note: null,
        approved_override: null,
        resulting_supermarket_product_id: null,
        resulting_snapshot_id: null,
      })
      .in(
        'id',
        approvedItems.map((i) => i.id as string),
      );
    if (error) throw error;
  }

  // 6. Pause mappings that no longer have any approved revista item pointing at them.
  for (const spId of spIds) {
    const { count } = await db
      .from('revista_review_items')
      .select('id', { count: 'exact', head: true })
      .eq('resulting_supermarket_product_id', spId)
      .eq('status', 'approved');
    if ((count ?? 0) === 0) {
      await db.from('supermarket_products').update({ is_active: false }).eq('id', spId);
    }
  }

  // 7. Magazines back to in_review (so they resurface in /pending once items are pending).
  const { error: magUpdErr } = await db
    .from('revista_magazines')
    .update({ status: 'in_review', reviewed_at: null })
    .in('id', magazineIds)
    .in('status', ['reviewed', 'in_review']);
  if (magUpdErr) throw magUpdErr;

  const today = buenosAiresDate();
  console.log(`\nDone. Soft-reset ${supermarketId} for BA day ${today}.`);
  console.log('Magazines kept; items back to pending; revista snapshots removed from client_base.\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('reset-revista-chain failed:', err);
  process.exit(1);
});
