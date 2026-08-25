/**
 * Retroactively fix Coto discount columns on already-scraped snapshots.
 *
 * The Coto adapter used to look for discount fields that Coto never emits, so
 * every past Coto snapshot was persisted with a NULL `offer_price_1` /
 * `unit_discount` and a generic "Descuento" text — even when the product was on
 * sale. We keep the FULL Coto attribute bag in `price_snapshots.raw_data.attributes`
 * (plus the json-ld string in `raw_data.jsonLd`), so we can re-derive the correct
 * discount columns offline WITHOUT re-scraping.
 *
 * For each Coto `ok` snapshot we reconstruct the original `?format=json` envelope
 * from raw_data, run the SAME parser a live scrape uses (`parseCotoResponse` +
 * `flattenPromotions`), and rewrite ONLY the promotion columns
 * (offer_price_1/2, promotion_1/2, unit_discount, promotions). Price / status /
 * stock / raw_data are never touched. Rows that don't change are skipped, so a
 * re-run is cheap and idempotent, and non-discounted products are left alone.
 *
 * Because the client_base view derives Precio_c_Oferta_1 / Descuento_Unitario
 * from these columns, fixing them here also fixes every historical export.
 *
 * Usage (use `npx tsx` directly — PowerShell drops `--` in `npm run … -- <flags>`):
 *   npx tsx --env-file=.env scripts/backfill-coto-promos.ts [--from=YYYY-MM-DD] [--to=YYYY-MM-DD] [--apply]
 *
 *   (default is a read-only dry-run that reports what WOULD change)
 */

import { db } from '../src/shared/db.js';
import { logger } from '../src/shared/logger.js';
import { parseCotoResponse } from '../src/adapters/coto.js';
import { flattenPromotions } from '../src/worker/promotions.js';

function argVal(name: string): string | undefined {
  const pref = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : undefined;
}

const fromDate = argVal('from');
const toDate = argVal('to');
const apply = process.argv.includes('--apply');

const PAGE = 1000;
const UPDATE_CONCURRENCY = 15;

/** Quiet logger so a rare json-ld parse warning doesn't spam the run. */
const quietLog = {
  info: () => undefined,
  debug: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quietLog,
} as unknown as typeof logger;

interface SnapRow {
  id: number;
  price: number | string | null;
  offer_price_1: number | string | null;
  offer_price_2: number | string | null;
  promotion_1: string | null;
  promotion_2: string | null;
  unit_discount: number | string | null;
  raw_data: Record<string, unknown> | null;
  supermarket_products: { external_id: string } | { external_id: string }[] | null;
}

interface NewPromoCols {
  offer_price_1: number | null;
  offer_price_2: number | null;
  promotion_1: string | null;
  promotion_2: string | null;
  unit_discount: number | null;
  promotions: unknown[];
}

/** Compare two possibly-stringified numbers (null-safe, 2-decimal tolerant). */
function numEq(a: number | string | null, b: number | null): boolean {
  const an = a == null ? null : Number(a);
  if (an === null && b === null) return true;
  if (an === null || b === null) return false;
  return Math.abs(an - b) < 0.005;
}

function strEq(a: string | null, b: string | null): boolean {
  return (a ?? null) === (b ?? null);
}

/** Recompute the promo columns for one snapshot from its stored raw_data. */
function recompute(row: SnapRow): NewPromoCols | null {
  const raw = row.raw_data;
  const attrs = raw?.['attributes'];
  if (!attrs || typeof attrs !== 'object') return null;

  const sp = Array.isArray(row.supermarket_products)
    ? row.supermarket_products[0]
    : row.supermarket_products;
  const externalId = sp?.external_id ?? 'unknown';

  const jsonLd = raw?.['jsonLd'];
  const body = {
    contents: [
      {
        Main: [
          {
            record: { attributes: attrs as Record<string, unknown> },
            ...(typeof jsonLd === 'string' ? { 'json-ld': jsonLd } : {}),
          },
        ],
      },
    ],
  };

  let result;
  try {
    result = parseCotoResponse(body, { externalId, logger: quietLog });
  } catch {
    // price_missing / selector_failed on a malformed old blob — skip it.
    return null;
  }

  // Flatten against the snapshot's own persisted regular price so we never
  // shift the base (an `ok` snapshot's stored price IS the regular price).
  const base = row.price == null ? result.price : Number(row.price);
  const flat = flattenPromotions(result.promotions, base);

  return {
    offer_price_1: flat.offer_price_1,
    offer_price_2: flat.offer_price_2,
    promotion_1: flat.promotion_1,
    promotion_2: flat.promotion_2,
    unit_discount: flat.unit_discount,
    promotions: result.promotions ?? [],
  };
}

/** True when the recomputed promo columns differ from what's stored. */
function changed(row: SnapRow, next: NewPromoCols): boolean {
  return (
    !numEq(row.offer_price_1, next.offer_price_1) ||
    !numEq(row.offer_price_2, next.offer_price_2) ||
    !numEq(row.unit_discount, next.unit_discount) ||
    !strEq(row.promotion_1, next.promotion_1) ||
    !strEq(row.promotion_2, next.promotion_2)
  );
}

async function main(): Promise<void> {
  console.log(
    `Coto promo backfill | window=${fromDate ?? 'start'}..${toDate ?? 'now'} | ` +
      `mode=${apply ? 'APPLY (writes updates)' : 'dry-run (report only)'}`,
  );

  let scanned = 0;
  let recomputable = 0;
  let toChange = 0;
  let applied = 0;
  const samples: string[] = [];

  for (let offset = 0; ; offset += PAGE) {
    let query = db
      .from('price_snapshots')
      .select(
        'id, price, offer_price_1, offer_price_2, promotion_1, promotion_2, unit_discount, raw_data, supermarket_products!inner(supermarket_id, external_id)',
      )
      .eq('supermarket_products.supermarket_id', 'coto')
      .eq('status', 'ok')
      .order('id', { ascending: true })
      .range(offset, offset + PAGE - 1);

    if (fromDate) query = query.gte('scraped_at', fromDate);
    if (toDate) query = query.lte('scraped_at', `${toDate}T23:59:59.999Z`);

    const { data, error } = await query;
    if (error) throw error;
    const rows = (data ?? []) as unknown as SnapRow[];
    if (rows.length === 0) break;

    const pending: { id: number; next: NewPromoCols }[] = [];
    for (const row of rows) {
      scanned++;
      const next = recompute(row);
      if (!next) continue;
      recomputable++;
      if (!changed(row, next)) continue;
      toChange++;
      pending.push({ id: row.id, next });
      if (samples.length < 12) {
        samples.push(
          `  #${row.id}: offer ${row.offer_price_1 ?? '∅'}→${next.offer_price_1 ?? '∅'} | ` +
            `desc ${row.unit_discount ?? '∅'}→${next.unit_discount ?? '∅'} | ` +
            `promo "${row.promotion_1 ?? ''}"→"${next.promotion_1 ?? ''}"`,
        );
      }
    }

    if (apply && pending.length > 0) {
      for (let i = 0; i < pending.length; i += UPDATE_CONCURRENCY) {
        const batch = pending.slice(i, i + UPDATE_CONCURRENCY);
        const results = await Promise.all(
          batch.map((p) =>
            db
              .from('price_snapshots')
              .update({
                offer_price_1: p.next.offer_price_1,
                offer_price_2: p.next.offer_price_2,
                promotion_1: p.next.promotion_1,
                promotion_2: p.next.promotion_2,
                unit_discount: p.next.unit_discount,
                promotions: p.next.promotions,
              })
              .eq('id', p.id),
          ),
        );
        for (const r of results) {
          if (r.error) throw r.error;
          applied++;
        }
      }
    }

    if (rows.length < PAGE) break;
  }

  console.log(
    `\nScanned ${scanned} Coto 'ok' snapshots | recomputable ${recomputable} | ` +
      `would change ${toChange}${apply ? ` | applied ${applied}` : ''}`,
  );
  if (samples.length > 0) {
    console.log(`\nSample changes${apply ? '' : ' (dry-run — nothing written)'}:`);
    console.log(samples.join('\n'));
  }
  if (!apply && toChange > 0) {
    console.log('\nRe-run with --apply to write these fixes.');
  }
}

void main().catch((err) => {
  logger.error({ err }, 'coto promo backfill failed');
  process.exitCode = 1;
});
