/** TEMP: quantify recent la-anonima/carrefour scrape failures by error_type. Delete after. */
import { db } from '../src/shared/db.js';

const SUPERS = (process.argv[2] ?? 'la-anonima,carrefour').split(',');
const SINCE_HOURS = Number(process.argv[3] ?? '48');

interface JoinRow {
  error_type: string | null;
  error_message: string | null;
  finished_at: string | null;
  supermarket_products: {
    supermarket_id: string;
    external_url: string | null;
    external_id: string;
  } | { supermarket_id: string; external_url: string | null; external_id: string }[] | null;
}

async function main(): Promise<void> {
  const since = new Date(Date.now() - SINCE_HOURS * 3600_000).toISOString();
  for (const sup of SUPERS) {
    // Get product ids for this supermarket first (avoid huge joins).
    const prodIds = new Set<string>();
    // We page failed job_executions joined to supermarket_products and filter client-side.
    const { data, error } = await db
      .from('job_executions')
      .select(
        'error_type, error_message, finished_at, supermarket_products!inner(supermarket_id, external_url, external_id)',
      )
      .eq('status', 'failed')
      .gte('finished_at', since)
      .eq('supermarket_products.supermarket_id', sup)
      .limit(5000);
    if (error) {
      // eslint-disable-next-line no-console
      console.error(sup, 'query error', error);
      continue;
    }
    const rows = (data ?? []) as unknown as JoinRow[];
    const byType = new Map<string, number>();
    const samples = new Map<string, { url: string | null; msg: string | null }>();
    for (const r of rows) {
      const t = r.error_type ?? 'null';
      byType.set(t, (byType.get(t) ?? 0) + 1);
      const sp = Array.isArray(r.supermarket_products) ? r.supermarket_products[0] : r.supermarket_products;
      if (sp) prodIds.add(sp.external_id);
      if (!samples.has(t) && sp) samples.set(t, { url: sp.external_url, msg: r.error_message });
    }
    // eslint-disable-next-line no-console
    console.log(`\n===== ${sup} — failed jobs in last ${SINCE_HOURS}h: ${rows.length} (distinct products: ${prodIds.size}) =====`);
    for (const [t, n] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
      const s = samples.get(t);
      // eslint-disable-next-line no-console
      console.log(`  ${t.padEnd(22)} ${String(n).padStart(5)}  e.g. ${s?.url ?? ''}`);
      // eslint-disable-next-line no-console
      console.log(`        msg: ${(s?.msg ?? '').slice(0, 140)}`);
    }
  }
  process.exit(0);
}
void main().catch((e) => { console.error(e); process.exit(1); });
