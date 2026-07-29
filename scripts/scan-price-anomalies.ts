/**
 * Price-anomaly scanner — a review aid for the daily publication workflow.
 *
 * Some sites (notably VTEX/Cencosud — Vea/Jumbo/Disco) return a garbage low
 * price for out-of-stock products. The adapter/persist layer now maps a
 * `inStock === false` reading to an `out_of_stock` marker (no price), which
 * catches every case where the site DOES expose an availability flag.
 *
 * This scanner is the SAFETY NET for the residual case: a bogus low price that
 * the site reports as *available* (no OOS signal). It has no reliable per-site
 * flag to key off, so it detects statistical outliers instead:
 *
 *   1. CROSS-STORE (primary): the same EAN is sold at N other stores today.
 *      If this store's price is a small fraction of the peer median, it's
 *      almost certainly a data error (a $158 "2 L lavandina" next to $13 000
 *      peers). History-independent, so it works for freshly-ingested products.
 *   2. SELF-HISTORY (secondary): the mapping's own price collapsed vs. its
 *      recent median (last N days). Catches single-store products with no peers.
 *
 * A row is flagged only when it undercuts its baseline by more than the
 * threshold (default: price < 35% of baseline). Real promos rarely exceed
 * ~50% off, so a 65%+ collapse is almost always bogus.
 *
 * This is READ-ONLY: it prints a report (and optional Excel) for an operator to
 * review and flag before approving the day. It never mutates the DB.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/scan-price-anomalies.ts [--date=YYYY-MM-DD]
 *       [--threshold=0.35] [--min-peers=2] [--history-days=30] [--xlsx]
 *
 * NB: use `npx tsx` directly — PowerShell drops `--` in `npm run … -- <flags>`.
 */

import { db, fetchAllPages } from '../src/shared/db.js';

// -----------------------------------------------------------------------------
// CLI args
// -----------------------------------------------------------------------------

function argVal(name: string): string | undefined {
  const pref = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : undefined;
}
const THRESHOLD = Number(argVal('threshold') ?? '0.35');
const MIN_PEERS = Number(argVal('min-peers') ?? '2');
const HISTORY_DAYS = Number(argVal('history-days') ?? '30');
const WANT_XLSX = process.argv.includes('--xlsx');

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface SnapRow {
  id: string;
  supermarket_product_id: string;
  scraped_at: string;
  price: number | null;
  status: string;
  supermarket_products: {
    supermarket_id: string;
    products: { ean: string | null; name: string | null } | { ean: string | null; name: string | null }[] | null;
  } | null;
}

interface TodayItem {
  snapshotId: string;
  mappingId: string;
  store: string;
  ean: string;
  name: string;
  price: number;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function median(nums: number[]): number {
  if (nums.length === 0) return NaN;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function firstJoin<T>(v: T | T[] | null | undefined): T | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

/** The most recent calendar date (UTC) that has any snapshot. */
async function latestSnapshotDate(): Promise<string> {
  const { data, error } = await db
    .from('price_snapshots')
    .select('scraped_at')
    .order('scraped_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return String(data?.scraped_at ?? new Date().toISOString()).slice(0, 10);
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  const date = argVal('date') ?? (await latestSnapshotDate());
  const dayStart = `${date}T00:00:00.000Z`;
  const dayEnd = `${date}T23:59:59.999Z`;
  const histStart = new Date(new Date(dayStart).getTime() - HISTORY_DAYS * 86_400_000).toISOString();

  console.log(
    `scanning ${date} | threshold=${THRESHOLD} (flag price < ${Math.round(THRESHOLD * 100)}% of baseline) | ` +
      `min-peers=${MIN_PEERS} | history=${HISTORY_DAYS}d`,
  );

  // 1. Today's real-price ('ok') snapshots with EAN/store/name.
  const todayRows = await fetchAllPages<SnapRow>((from, to) =>
    db
      .from('price_snapshots')
      .select(
        'id, supermarket_product_id, scraped_at, price, status, supermarket_products:supermarket_product_id ( supermarket_id, products:product_id ( ean, name ) )',
      )
      .gte('scraped_at', dayStart)
      .lte('scraped_at', dayEnd)
      .eq('status', 'ok')
      .gt('price', 0)
      .order('id', { ascending: true })
      .range(from, to),
  );

  const items: TodayItem[] = [];
  for (const r of todayRows) {
    const sp = r.supermarket_products;
    if (!sp || r.price == null) continue;
    const prod = firstJoin(sp.products);
    const ean = prod?.ean ?? '';
    if (!ean) continue; // client keys on EAN; EAN-less rows aren't exported anyway
    items.push({
      snapshotId: r.id,
      mappingId: r.supermarket_product_id,
      store: sp.supermarket_id,
      ean,
      name: prod?.name ?? '',
      price: r.price,
    });
  }
  console.log(`today 'ok' priced snapshots (with EAN): ${items.length}`);

  // 2. Cross-store median per EAN for today.
  const byEan = new Map<string, number[]>();
  for (const it of items) {
    const arr = byEan.get(it.ean) ?? [];
    arr.push(it.price);
    byEan.set(it.ean, arr);
  }

  // 3. Per-mapping history median (last HISTORY_DAYS, excluding target day).
  const histRows = await fetchAllPages<{ supermarket_product_id: string; price: number | null }>((from, to) =>
    db
      .from('price_snapshots')
      .select('supermarket_product_id, price')
      .gte('scraped_at', histStart)
      .lt('scraped_at', dayStart)
      .eq('status', 'ok')
      .gt('price', 0)
      .order('id', { ascending: true })
      .range(from, to),
  );
  const histByMapping = new Map<string, number[]>();
  for (const h of histRows) {
    if (h.price == null) continue;
    const arr = histByMapping.get(h.supermarket_product_id) ?? [];
    arr.push(h.price);
    histByMapping.set(h.supermarket_product_id, arr);
  }

  // 4. Flag outliers.
  interface Flag extends TodayItem {
    baseline: number;
    ratio: number;
    source: 'cross-store' | 'self-history';
    peers: number;
  }
  const flags: Flag[] = [];
  for (const it of items) {
    // peer prices across OTHER stores for this EAN (exclude this row's own price once)
    const others = [...(byEan.get(it.ean) ?? [])];
    others.splice(others.indexOf(it.price), 1);
    const hist = histByMapping.get(it.mappingId) ?? [];

    let baseline = NaN;
    let source: Flag['source'] = 'cross-store';
    let peers = 0;
    if (others.length >= MIN_PEERS) {
      baseline = median(others);
      peers = others.length;
      source = 'cross-store';
    } else if (hist.length >= MIN_PEERS) {
      baseline = median(hist);
      peers = hist.length;
      source = 'self-history';
    } else {
      continue; // not enough signal to judge
    }

    if (!Number.isFinite(baseline) || baseline <= 0) continue;
    const ratio = it.price / baseline;
    if (ratio < THRESHOLD) {
      flags.push({ ...it, baseline, ratio, source, peers });
    }
  }

  flags.sort((a, b) => a.ratio - b.ratio);
  console.log(`\nANOMALIES: ${flags.length}\n`);
  for (const f of flags) {
    console.log(
      `  ${f.store.padEnd(16)} EAN=${f.ean} $${f.price} vs baseline $${f.baseline.toFixed(2)} ` +
        `(${Math.round(f.ratio * 100)}%, ${f.source}, peers=${f.peers}) | snap=${f.snapshotId} | ${f.name}`,
    );
  }

  if (WANT_XLSX && flags.length) {
    const ExcelJSmod = await import('exceljs');
    const ExcelJS = (ExcelJSmod as unknown as { default?: typeof import('exceljs') }).default ?? ExcelJSmod;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('anomalies');
    ws.addRow(['Store', 'EAN', 'Name', 'Price', 'Baseline', 'Ratio%', 'Source', 'Peers', 'SnapshotId']);
    for (const f of flags) {
      ws.addRow([f.store, f.ean, f.name, f.price, Number(f.baseline.toFixed(2)), Math.round(f.ratio * 100), f.source, f.peers, f.snapshotId]);
    }
    const out = `price-anomalies_${date}.xlsx`;
    await wb.xlsx.writeFile(out);
    console.log(`\nwrote ${out}`);
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
