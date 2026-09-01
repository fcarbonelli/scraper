/**
 * Repair snapshots where a promo field the reviewer CLEARED came back.
 *
 * Until 2026-09-01 the snapshot writer read `approved_override` with `??`, so a
 * deliberately cleared `promo_text` / `promo_price` (stored as null) fell back
 * to the AI's read and landed in the client Excel — `Promocion_1` showing
 * "OFERTA" on a row the panel displayed as empty. The writer is fixed, but rows
 * written before the fix stay wrong, and they cannot be repaired from the panel:
 * it already shows the intended (cleared) value, so `isDraftDirty` is false and
 * Guardar stays disabled. Hence this script.
 *
 * It groups by SNAPSHOT, not by item: repetidos (same product on two pages)
 * share one price row, and a group where one item cleared the text while
 * another deliberately typed "6 unidades" must NOT be touched — repairing it
 * per-item would delete the good value. Only groups whose items all agree on
 * the resulting columns are rewritten.
 *
 * Dry-run unless --apply. Applying writes a rollback JSON in the repo root.
 *
 * Usage (PowerShell eats the `--` separator, so pass flags via tsx directly):
 *   npx tsx --env-file=.env scripts/revistas-fix-cleared-promos.ts
 *   npx tsx --env-file=.env scripts/revistas-fix-cleared-promos.ts --day=2026-09-01
 *   npx tsx --env-file=.env scripts/revistas-fix-cleared-promos.ts --super=rosental --apply
 *
 * `npm run revistas:fix-promos` works for the no-flag (today, dry-run) case.
 */

import { writeFileSync } from 'node:fs';
import { db } from '../src/shared/db.js';
import {
  buenosAiresDate,
  isRevistaSnapshotSource,
  mapSnapshotPrices,
  snapshotPricesFromOverride,
  type ApprovedOverride,
  type MappedSnapshotColumns,
} from '../src/revistas/pricing.js';

/* eslint-disable no-console */

function getArg(name: string): string | undefined {
  const pref = `--${name}=`;
  return process.argv.find((a) => a.startsWith(pref))?.slice(pref.length);
}

interface ItemRow {
  id: string;
  supermarket_id: string;
  page_number: number | null;
  proposed_ean: string | null;
  extracted: {
    price?: number | null;
    promo_price?: number | null;
    promo_text?: string | null;
  } | null;
  approved_override: ApprovedOverride | null;
  resulting_snapshot_id: number | null;
}

interface SnapRow {
  id: number;
  scraped_on: string | null;
  scraped_at: string;
  price: number | null;
  list_price: number | null;
  offer_price_1: number | null;
  promotion_1: string | null;
  promotions: unknown;
  raw_data: { source?: string } | null;
}

/** The columns the fixed writer would produce for one review item. */
function intendedColumns(item: ItemRow): MappedSnapshotColumns {
  return mapSnapshotPrices(
    snapshotPricesFromOverride(
      {
        price: item.extracted?.price ?? null,
        promoPrice: item.extracted?.promo_price ?? null,
        promoText: item.extracted?.promo_text ?? null,
      },
      item.approved_override,
    ),
  );
}

/** Compare the four scalar columns this script rewrites (`promotions` follows). */
function sameColumns(a: MappedSnapshotColumns, b: MappedSnapshotColumns): boolean {
  return (
    a.price === b.price &&
    a.list_price === b.list_price &&
    a.offer_price_1 === b.offer_price_1 &&
    a.promotion_1 === b.promotion_1
  );
}

function currentColumns(snap: SnapRow): MappedSnapshotColumns {
  return {
    price: Number(snap.price),
    list_price: snap.list_price == null ? null : Number(snap.list_price),
    offer_price_1: snap.offer_price_1 == null ? null : Number(snap.offer_price_1),
    promotion_1: snap.promotion_1?.trim() ? snap.promotion_1 : null,
    promotions: [],
  };
}

async function main(): Promise<void> {
  const day = getArg('day') ?? buenosAiresDate();
  const supermarketId = getArg('super');
  const apply = process.argv.includes('--apply');

  console.log(
    `\nFIX CLEARED REVISTA PROMOS — day=${day}${supermarketId ? ` super=${supermarketId}` : ''}` +
      `${apply ? '' : '  (DRY-RUN — pasá --apply para escribir)'}\n`,
  );

  let query = db
    .from('revista_review_items')
    .select(
      'id, supermarket_id, page_number, proposed_ean, extracted, approved_override, resulting_snapshot_id',
    )
    .eq('status', 'approved')
    .not('resulting_snapshot_id', 'is', null);
  if (supermarketId) query = query.eq('supermarket_id', supermarketId);
  const { data: itemData, error: itemErr } = await query;
  if (itemErr) throw itemErr;
  const items = (itemData ?? []) as ItemRow[];

  // Keep only the snapshots dated the requested BA day and owned by revista.
  const ids = [...new Set(items.map((i) => i.resulting_snapshot_id as number))];
  const snaps = new Map<number, SnapRow>();
  for (let i = 0; i < ids.length; i += 500) {
    const { data, error } = await db
      .from('price_snapshots')
      .select(
        'id, scraped_on, scraped_at, price, list_price, offer_price_1, promotion_1, promotions, raw_data',
      )
      .in('id', ids.slice(i, i + 500));
    if (error) throw error;
    for (const row of (data ?? []) as SnapRow[]) {
      const rowDay = row.scraped_on ?? buenosAiresDate(new Date(row.scraped_at));
      if (rowDay !== day) continue;
      if (!isRevistaSnapshotSource(row.raw_data?.source)) continue;
      snaps.set(row.id, row);
    }
  }

  // Group the items by the price row they share.
  const groups = new Map<number, ItemRow[]>();
  for (const item of items) {
    const id = item.resulting_snapshot_id as number;
    if (!snaps.has(id)) continue;
    groups.set(id, [...(groups.get(id) ?? []), item]);
  }

  const toFix: Array<{ snap: SnapRow; group: ItemRow[]; want: MappedSnapshotColumns }> = [];
  const conflicts: Array<{ snap: SnapRow; group: ItemRow[] }> = [];
  let settled = 0;

  for (const [snapId, group] of groups) {
    const snap = snaps.get(snapId) as SnapRow;
    const current = currentColumns(snap);
    const wanted = group.map(intendedColumns);
    const first = wanted[0] as MappedSnapshotColumns;

    if (!wanted.every((w) => sameColumns(w, first))) {
      // Repetidos whose items disagree — one cleared the text, the sibling typed
      // one. Whichever was approved last won the shared row. If the row already
      // matches one of them it holds a legitimate operator value, so leave it be
      // and don't nag; only a row matching NONE of them needs a human.
      if (wanted.some((w) => sameColumns(current, w))) settled++;
      else conflicts.push({ snap, group });
      continue;
    }
    if (sameColumns(current, first)) continue;
    toFix.push({ snap, group, want: first });
  }

  const label = (g: ItemRow[]): string => {
    const pages = [...new Set(g.map((i) => i.page_number))].join('+');
    return `${g[0]?.supermarket_id} ${g[0]?.proposed_ean ?? '(sin ean)'} pág ${pages}`;
  };
  const show = (v: string | number | null): string => (v == null ? '-' : String(v));

  console.log(`A REPARAR: ${toFix.length}`);
  for (const { snap, group, want } of toFix) {
    console.log(`  snap ${snap.id} | ${label(group)}`);
    console.log(
      `      antes:   price=${show(snap.price)} list=${show(snap.list_price)} ` +
        `off1=${show(snap.offer_price_1)} promo='${snap.promotion_1 ?? ''}'`,
    );
    console.log(
      `      después: price=${show(want.price)} list=${show(want.list_price)} ` +
        `off1=${show(want.offer_price_1)} promo='${want.promotion_1 ?? ''}'`,
    );
  }

  if (settled > 0) {
    console.log('');
    console.log(
      `${settled} snapshot(s) de productos repetidos con ítems en desacuerdo, pero ya con ` +
        'un valor puesto por el operador — se dejan como están.',
    );
  }

  console.log('');
  console.log(
    `REVISAR A MANO (repetidos en desacuerdo, sin un valor del operador): ${conflicts.length}`,
  );
  for (const { snap, group } of conflicts) {
    console.log(`  snap ${snap.id} | ${label(group)} | promo actual='${snap.promotion_1 ?? ''}'`);
    for (const item of group) {
      const ov = item.approved_override;
      const shown =
        ov && 'promo_text' in ov
          ? ov.promo_text === null
            ? 'null (vaciar)'
            : `'${ov.promo_text}'`
          : '(sin override)';
      console.log(`      pág ${item.page_number}: ${shown}`);
    }
  }

  if (!apply) {
    console.log('\nDRY-RUN: no se escribió nada. Agregá --apply para aplicar.\n');
    process.exit(0);
  }
  if (toFix.length === 0) {
    console.log('\nNada para aplicar.\n');
    process.exit(0);
  }

  const rollback = toFix.map(({ snap }) => ({
    id: snap.id,
    price: snap.price,
    list_price: snap.list_price,
    offer_price_1: snap.offer_price_1,
    promotion_1: snap.promotion_1,
    promotions: snap.promotions,
  }));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = `revista-fix-cleared-promos-rollback-${stamp}.json`;
  writeFileSync(file, JSON.stringify(rollback, null, 2), 'utf8');
  console.log(`\nRollback guardado en ${file}`);

  let done = 0;
  for (const { snap, want } of toFix) {
    const { error } = await db
      .from('price_snapshots')
      .update({
        price: want.price,
        list_price: want.list_price,
        offer_price_1: want.offer_price_1,
        promotion_1: want.promotion_1,
        promotions: want.promotions,
      })
      .eq('id', snap.id);
    if (error) throw error;
    done++;
  }
  console.log(`Listo. ${done} snapshots reparados.\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error('revistas-fix-cleared-promos failed:', err);
  process.exit(1);
});
