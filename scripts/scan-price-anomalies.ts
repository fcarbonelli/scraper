/**
 * Price-anomaly scanner / backfill CLI.
 *
 * Thin wrapper over the shared detection+suppression core
 * (src/shared/priceAnomaly.ts) — the SAME logic the daily run-finalizer uses to
 * auto-suppress bogus low prices. Use this to:
 *   - inspect a past/other day's outliers (default: read-only report), or
 *   - retroactively clean a day that was scraped before auto-suppression existed
 *     (pass --apply to rewrite the flagged snapshots to `out_of_stock` markers).
 *
 * Detection: for each 'ok' priced scraped snapshot, compare against the same-day
 * cross-store median (scoped to the same channel family) or, failing enough
 * peers, the mapping's own recent median. Flags a 65%+ collapse by default.
 * Trusted in-store/manual (run-less) snapshots are never considered.
 *
 * Usage (use `npx tsx` directly — PowerShell drops `--` in `npm run … -- <flags>`):
 *   npx tsx --env-file=.env scripts/scan-price-anomalies.ts [--date=YYYY-MM-DD | --days=N]
 *       [--threshold=0.35] [--target-threshold=0.25] [--min-peers=2]
 *       [--history-days=30] [--xlsx] [--apply]
 *
 *   --days=N   scan the last N calendar days (backfill a window), instead of a
 *              single --date. Applies/reports across every day in the range.
 */

import {
  runAnomalySuppression,
  DEFAULT_ANOMALY_OPTIONS,
  type AnomalyFlag,
} from '../src/shared/priceAnomaly.js';

function argVal(name: string): string | undefined {
  const pref = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : undefined;
}

const date = argVal('date');
const days = argVal('days') ? Number(argVal('days')) : undefined;
const threshold = Number(argVal('threshold') ?? String(DEFAULT_ANOMALY_OPTIONS.threshold));
const targetThreshold = Number(argVal('target-threshold') ?? String(DEFAULT_ANOMALY_OPTIONS.targetThreshold));
const minPeers = Number(argVal('min-peers') ?? String(DEFAULT_ANOMALY_OPTIONS.minPeers));
const historyDays = Number(argVal('history-days') ?? String(DEFAULT_ANOMALY_OPTIONS.historyDays));
const wantXlsx = process.argv.includes('--xlsx');
const apply = process.argv.includes('--apply');

/** UTC YYYY-MM-DD, `back` days before today. */
function dateNDaysAgo(back: number): string {
  return new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const scope = days ? `last ${days} day(s)` : (date ?? '(latest day)');
  console.log(
    `scanning ${scope} | median<${Math.round(threshold * 100)}% of baseline | ` +
      `target<${Math.round(targetThreshold * 100)}% of EDP | ` +
      `min-peers=${minPeers} | history=${historyDays}d | mode=${apply ? 'APPLY (suppress)' : 'dry-run (report only)'}`,
  );

  const opts = { threshold, targetThreshold, minPeers, historyDays };
  const flags: AnomalyFlag[] = [];
  if (days) {
    for (let i = days - 1; i >= 0; i--) {
      const d = dateNDaysAgo(i);
      const dayFlags = await runAnomalySuppression({ date: d, dryRun: !apply, options: opts });
      flags.push(...dayFlags);
    }
  } else {
    flags.push(...(await runAnomalySuppression({ date, dryRun: !apply, options: opts })));
  }

  console.log(`\nANOMALIES: ${flags.length}\n`);
  for (const f of flags) {
    const base = f.source === 'target' ? 'EDP' : 'baseline';
    console.log(
      `  ${f.store.padEnd(16)} [${f.canalFamily}] EAN=${f.ean} $${f.price} vs ${base} ` +
        `$${f.baseline.toFixed(2)} (${Math.round(f.ratio * 100)}%, ${f.source}, peers=${f.peers}) | ` +
        `snap=${f.snapshotId} | ${f.name}`,
    );
  }

  // Summary: by source, and by how far below baseline (helps judge false-positive risk).
  const bySource: Record<string, number> = {};
  const bands: Record<string, number> = { '<5%': 0, '5-10%': 0, '10-25%': 0, '25-35%': 0 };
  for (const f of flags) {
    bySource[f.source] = (bySource[f.source] ?? 0) + 1;
    const pct = f.ratio * 100;
    if (pct < 5) bands['<5%']!++;
    else if (pct < 10) bands['5-10%']!++;
    else if (pct < 25) bands['10-25%']!++;
    else bands['25-35%']!++;
  }
  console.log('\nby source:', bySource);
  console.log('by ratio band:', bands);

  if (apply) {
    console.log(`\nAPPLIED: suppressed ${flags.length} snapshot(s) → out_of_stock (price cleared).`);
  } else if (flags.length) {
    console.log('\nDRY-RUN. Re-run with --apply to suppress these snapshots.');
  }

  if (wantXlsx && flags.length) {
    const ExcelJSmod = await import('exceljs');
    const ExcelJS = (ExcelJSmod as unknown as { default?: typeof import('exceljs') }).default ?? ExcelJSmod;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('anomalies');
    ws.addRow(['Store', 'Canal', 'EAN', 'Name', 'Price', 'Baseline', 'Ratio%', 'Source', 'Peers', 'SnapshotId']);
    for (const f of flags) {
      ws.addRow([
        f.store, f.canalFamily, f.ean, f.name, f.price,
        Number(f.baseline.toFixed(2)), Math.round(f.ratio * 100), f.source, f.peers, f.snapshotId,
      ]);
    }
    const out = `price-anomalies_${date ?? 'latest'}.xlsx`;
    await wb.xlsx.writeFile(out);
    console.log(`\nwrote ${out}`);
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
