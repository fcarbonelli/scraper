/**
 * La Anónima sucursal-coverage experiment (READ-ONLY).
 *
 * WHY: La Anónima's online "super" catalog is scoped by the `Id-Sucursal-Super`
 * cookie, and only a subset of the ~180 physical branches actually fulfil the
 * online super catalog. Our daily scrape sweeps a small fixed list of branch
 * ids; products stocked ONLY in branches outside that list come back as
 * out-of-stock even though the client finds them by browsing another branch
 * (e.g. "9 de Julio"). This script measures, against the LIVE site, which
 * branches would recover the products that are currently non-purchasable, and
 * prints a recommended curated sweep list to bake into
 * LA_ANONIMA_SUCURSAL_FALLBACKS.
 *
 * RUN ON A HOST WITH WORKING EGRESS (the production EC2, where AR_PROXY_URL is
 * set). It makes NO writes — only GETs against laanonima.com.ar and one SELECT
 * against Supabase.
 *
 *   npm run laanonima:coverage
 *   # optional flags:
 *   #   --max-products=N   cap how many problem products to sweep (default: all)
 *   #   --curated=K        target size of the recommended list (default: 30)
 *   #   --concurrency=C    parallel requests (default: 6)
 */
import { fetch as undiciFetch } from 'undici';
import * as fs from 'node:fs';
import { getProxyDispatcher, getFreshProxyDispatcher, usesProxy } from '../src/shared/proxy.js';
import { extractProductJsonLd } from '../src/adapters/la-anonima.js';
import { db } from '../src/shared/db.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const ALL_SUCURSALES_URL =
  'https://www.laanonima.com.ar/empresa/contents/themes/evolucionamos/bin/get_all_sucursales.php';

// -------- CLI flags -----------------------------------------------------------
function flag(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : undefined;
}
const MAX_PRODUCTS = Number(flag('max-products') ?? '0') || 0; // 0 = all
const CURATED_TARGET = Number(flag('curated') ?? '30');
const CONCURRENCY = Math.max(1, Number(flag('concurrency') ?? '6'));

// -------- helpers -------------------------------------------------------------
function ck(id: number): string {
  return `Id-Sucursal-Super=${id}; Id-Sucursal-Super-DisponibleYa=${id}; seleccionocp=1`;
}
function isHome(finalUrl: string): boolean {
  try {
    return new URL(finalUrl).pathname.replace(/\/+$/, '') === '';
  } catch {
    return false;
  }
}

interface ProbeResult {
  status: 'ok' | 'oos' | 'home' | 'block' | 'error';
  price?: number;
}

/** One GET with WAF-403 fallback onto fresh proxy exit IPs (like the adapter). */
async function probe(url: string, cookie?: string): Promise<ProbeResult> {
  const rotations = usesProxy('la-anonima') ? 3 : 0;
  for (let attempt = 0; attempt <= rotations; attempt++) {
    let fresh: ReturnType<typeof getFreshProxyDispatcher>;
    let dispatcher = getProxyDispatcher('la-anonima');
    if (attempt > 0) {
      fresh = getFreshProxyDispatcher('la-anonima');
      dispatcher = fresh?.dispatcher;
    }
    try {
      const res = await undiciFetch(url, {
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml,*/*',
          'Accept-Language': 'es-AR,es;q=0.9',
          ...(cookie ? { Cookie: cookie } : {}),
        },
        redirect: 'follow',
        ...(dispatcher ? { dispatcher } : {}),
      });
      if (res.status === 403) continue; // rotate exit IP
      if (res.status !== 200) return { status: 'error' };
      if (isHome(res.url)) return { status: 'home' };
      const p = extractProductJsonLd(await res.text());
      if (!p) return { status: 'error' };
      const offer = Array.isArray(p.offers) ? p.offers[0] : p.offers;
      const price = Number(offer?.price);
      const inStock = /InStock/i.test(offer?.availability ?? '');
      return inStock && Number.isFinite(price) && price > 0
        ? { status: 'ok', price }
        : { status: 'oos' };
    } catch {
      return { status: 'error' };
    } finally {
      await fresh?.close();
    }
  }
  return { status: 'block' };
}

/** Run `worker` over `items` with bounded concurrency, preserving input order. */
async function mapPool<T, R>(items: T[], limit: number, worker: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function run(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      out[i] = await worker(items[i]!, i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

interface Sucursal {
  nombre: string;
  sucursal: string;
}
interface Product {
  id: string;
  externalUrl: string;
}

async function fetchAllSucursales(): Promise<Array<{ code: number; nombre: string }>> {
  const dispatcher = getProxyDispatcher('la-anonima');
  const res = await undiciFetch(ALL_SUCURSALES_URL, {
    headers: { 'User-Agent': UA, Accept: 'application/json,*/*', 'X-Requested-With': 'XMLHttpRequest' },
    ...(dispatcher ? { dispatcher } : {}),
  });
  const arr = (await res.json()) as Sucursal[];
  return arr
    .map((s) => ({ code: Number(s.sucursal), nombre: s.nombre }))
    .filter((s) => Number.isInteger(s.code) && s.code > 0);
}

async function main(): Promise<void> {
  console.log(`proxy for la-anonima: ${usesProxy('la-anonima') ? 'ON' : 'OFF (direct)'}`);
  const branches = await fetchAllSucursales();
  console.log(`sucursales listed: ${branches.length}`);

  const { data } = await db
    .from('supermarket_products')
    .select('id, external_url')
    .eq('supermarket_id', 'la-anonima')
    .eq('is_active', true);
  const products: Product[] = (data ?? [])
    .filter((r) => r.external_url)
    .map((r) => ({ id: r.id as string, externalUrl: r.external_url as string }));
  console.log(`active products: ${products.length}\n`);

  // ---- 1. Probe every product at the IP-default (no sucursal cookie). --------
  console.log('step 1/3: probing products at default egress…');
  const defResults = await mapPool(products, CONCURRENCY, (p) => probe(p.externalUrl));
  const problems: Product[] = [];
  let okDefault = 0;
  const canaries: Product[] = [];
  defResults.forEach((r, i) => {
    if (r.status === 'ok') {
      okDefault++;
      if (canaries.length < 5) canaries.push(products[i]!);
    } else {
      problems.push(products[i]!);
    }
  });
  console.log(`  in-stock at default: ${okDefault} | problem (OOS/home/none): ${problems.length}`);
  if (canaries.length === 0) {
    console.log('No in-stock canary products found (site may be blocking). Aborting.');
    return;
  }

  // ---- 2. Find super-enabled branches using the canaries. -------------------
  console.log(`\nstep 2/3: detecting super-enabled branches with ${canaries.length} canaries…`);
  const superBranches = (
    await mapPool(branches, CONCURRENCY, async (b) => {
      for (const c of canaries) {
        const r = await probe(c.externalUrl, ck(b.code));
        if (r.status === 'ok' || r.status === 'oos') return b; // resolves a PDP → super-enabled
      }
      return null;
    })
  ).filter((b): b is { code: number; nombre: string } => b !== null);
  console.log(`  super-enabled branches: ${superBranches.length} / ${branches.length}`);

  // ---- 3. For each problem product, which super branches supply it in stock? -
  const problemSet = MAX_PRODUCTS > 0 ? problems.slice(0, MAX_PRODUCTS) : problems;
  console.log(`\nstep 3/3: sweeping ${superBranches.length} branches over ${problemSet.length} problem products…`);
  // recoveredBy[productIndex] = Set of branch codes that have it in stock
  const recoveredBy = new Map<string, Set<number>>();
  const branchHits = new Map<number, Set<string>>(); // branch code → product ids it recovers
  for (const b of superBranches) branchHits.set(b.code, new Set());

  await mapPool(problemSet, CONCURRENCY, async (p) => {
    const found = new Set<number>();
    for (const b of superBranches) {
      const r = await probe(p.externalUrl, ck(b.code));
      if (r.status === 'ok') {
        found.add(b.code);
        branchHits.get(b.code)!.add(p.id);
      }
    }
    if (found.size > 0) recoveredBy.set(p.id, found);
  });

  const recoverable = recoveredBy.size;
  const neverFound = problemSet.length - recoverable;

  // ---- Greedy set cover: pick branches that recover the most NEW products. --
  const remaining = new Set(recoveredBy.keys());
  const curated: Array<{ code: number; nombre: string; newly: number }> = [];
  const byCode = new Map(superBranches.map((b) => [b.code, b.nombre] as const));
  while (remaining.size > 0 && curated.length < CURATED_TARGET) {
    let best: { code: number; gain: number } | null = null;
    for (const [code, ids] of branchHits) {
      let gain = 0;
      for (const id of ids) if (remaining.has(id)) gain++;
      if (gain > 0 && (!best || gain > best.gain)) best = { code, gain };
    }
    if (!best) break;
    for (const id of branchHits.get(best.code)!) remaining.delete(id);
    curated.push({ code: best.code, nombre: byCode.get(best.code) ?? '?', newly: best.gain });
  }

  // ---- Report --------------------------------------------------------------
  console.log('\n================ RESULTS ================');
  console.log(`products in-stock at default:            ${okDefault}`);
  console.log(`problem products swept:                  ${problemSet.length}`);
  console.log(`  recoverable in some super branch:      ${recoverable}`);
  console.log(`  not found in ANY super branch:         ${neverFound}`);

  const ranked = [...branchHits.entries()]
    .map(([code, ids]) => ({ code, nombre: byCode.get(code) ?? '?', hits: ids.size }))
    .filter((r) => r.hits > 0)
    .sort((a, b) => b.hits - a.hits);
  console.log('\nTop branches by problem-products-in-stock:');
  for (const r of ranked.slice(0, 25)) console.log(`  ${String(r.code).padStart(4)}  ${r.nombre.padEnd(28)} ${r.hits}`);

  console.log(`\nRecommended curated sweep (greedy cover, ${curated.length} branches, covers ${recoverable - remaining.size}/${recoverable} recoverable):`);
  for (const c of curated) console.log(`  ${String(c.code).padStart(4)}  ${c.nombre.padEnd(28)} +${c.newly}`);
  console.log('\nPaste into the environment / ecosystem config:');
  console.log(`LA_ANONIMA_SUCURSAL_FALLBACKS="${curated.map((c) => c.code).join(',')}"`);

  const outPath = 'laanonima-branch-coverage.json';
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      { okDefault, problems: problemSet.length, recoverable, neverFound, ranked, curated, superBranches },
      null,
      2,
    ),
  );
  console.log(`\nfull report saved to ${outPath}`);
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
