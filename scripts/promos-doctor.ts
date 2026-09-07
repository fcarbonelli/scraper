/**
 * Diagnose the promotions pipeline — no DB writes, no heavy fetch.
 *
 * Checks:
 *   1. Registered providers vs DB (promo_providers) rows.
 *   2. Naranja X reachability: the public taxonomy endpoint + one list page,
 *      reporting HTTP status and a sample count so "nothing shows up" is easy
 *      to triage.
 *
 * Usage: npx tsx --env-file=.env scripts/promos-doctor.ts
 */

import { db } from '../src/shared/db.js';
import { listProviders } from '../src/promos/registry.js';

const NX_BASE = 'https://bkn-promotions.naranjax.com/bff-promotions-web/api';
const HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
  Origin: 'https://www.naranjax.com',
  Referer: 'https://www.naranjax.com/promociones/',
  Accept: 'application/json, text/plain, */*',
};

function line(label: string, value: unknown): void {
  // eslint-disable-next-line no-console
  console.log(`${label.padEnd(28)} ${String(value)}`);
}

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log('\n=========== PROMOS DOCTOR ===========\n');

  // 1. Registered vs DB providers.
  const registered = listProviders().map((p) => p.id);
  line('Registered providers', registered.join(', ') || '(none)');

  const { data: rows, error } = await db
    .from('promo_providers')
    .select('id, name, active, last_run_at');
  if (error) {
    line('DB promo_providers', `ERROR: ${error.message}`);
  } else {
    line('DB providers', (rows ?? []).map((r) => `${r.id}${r.active ? '' : '(inactive)'}`).join(', ') || '(none)');
    for (const r of rows ?? []) {
      line(`  last_run ${r.id}`, r.last_run_at ?? '(never)');
    }
  }

  // 2. Naranja X reachability.
  // eslint-disable-next-line no-console
  console.log('\n--- Naranja X reachability ---');
  try {
    const t0 = Date.now();
    const taxRes = await fetch(`${NX_BASE}/data-for-filter`, { headers: HEADERS });
    const tax = taxRes.ok ? ((await taxRes.json()) as Record<string, unknown>) : null;
    const cats = Array.isArray(tax?.['categories']) ? (tax!['categories'] as unknown[]).length : 0;
    line('GET /data-for-filter', `HTTP ${taxRes.status} · categories=${cats} · ${Date.now() - t0}ms`);
  } catch (err) {
    line('GET /data-for-filter', `FAILED: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const t0 = Date.now();
    const listRes = await fetch(`${NX_BASE}/binder/filter`, {
      method: 'POST',
      headers: { ...HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filters: { categories: [{ key: 'SUPERMERCADOS' }] },
        pageOptions: { page: 1, size: 5 },
      }),
    });
    const body = listRes.ok ? ((await listRes.json()) as Record<string, unknown>) : null;
    const total = body ? Number((body['info'] as Record<string, unknown> | undefined)?.['total'] ?? 0) : 0;
    line('POST /binder/filter', `HTTP ${listRes.status} · total(supermercados)=${total} · ${Date.now() - t0}ms`);
  } catch (err) {
    line('POST /binder/filter', `FAILED: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3. Stored counts.
  const { count } = await db
    .from('promotions')
    .select('id', { count: 'exact', head: true })
    .eq('is_active', true);
  // eslint-disable-next-line no-console
  console.log('');
  line('Active promotions stored', count ?? 0);

  // eslint-disable-next-line no-console
  console.log('\n=====================================\n');
  process.exit(0);
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('promos:doctor failed:', err);
  process.exit(1);
});
