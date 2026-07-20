// TEMP: audit duplicate product rows (same item under a client EAN vs a scraped 'site' EAN). Delete after.
import ExcelJSmod from 'exceljs';
import { db } from '../src/shared/db.js';
import { writeFileSync } from 'node:fs';

const ExcelJS = (ExcelJSmod as unknown as { default?: typeof import('exceljs') }).default ?? ExcelJSmod;
const SHEET = 'C:\\Users\\fran-\\Downloads\\Excel URL unificado (1).xlsx';
const OUT = 'C:\\Users\\fran-\\Downloads\\duplicados_ean_plan.csv';

const cs = (v: unknown): string => v == null ? '' : (typeof v === 'object' ? String((v as { result?: unknown; text?: unknown }).result ?? (v as { text?: unknown }).text ?? '') : String(v)).trim();
const strip = (s: string): string => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
// Sorted-token key of brand+name → robust to case/accents/word-order/punctuation.
function nameKey(name: string, brand: string): string {
  const toks = strip(`${brand} ${name}`).replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  return [...new Set(toks)].sort().join(' ');
}

async function fetchAll<T>(table: string, cols: string, orderBy: string): Promise<T[]> {
  const all: T[] = []; let off = 0;
  for (;;) { const { data, error } = await db.from(table).select(cols).order(orderBy).range(off, off + 999);
    if (error) throw error; const r = (data ?? []) as unknown as T[]; all.push(...r); if (r.length < 1000) break; off += 1000; }
  return all;
}

async function main(): Promise<void> {
  // ---- client's canonical EAN list (distinct EANs across the URL sheet) ----
  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(SHEET);
  const ws = wb.getWorksheet('Productos')!;
  const clientEans = new Set<string>();
  for (let r = 2; r <= ws.rowCount; r++) { const e = cs(ws.getRow(r).getCell(2).value).replace(/\D/g, ''); if (e) clientEans.add(e); }
  console.log(`Client distinct EANs (from URL sheet): ${clientEans.size}`);

  // ---- our products + mappings ----
  const products = await fetchAll<{ id: string; ean: string | null; name: string | null; brand: string | null }>('products', 'id, ean, name, brand', 'id');
  const maps = await fetchAll<{ product_id: string; supermarket_id: string; is_active: boolean }>('supermarket_products', 'product_id, supermarket_id, is_active', 'product_id');
  const mapsByProd = new Map<string, { supermarket_id: string; is_active: boolean }[]>();
  for (const m of maps) { const a = mapsByProd.get(m.product_id) ?? []; a.push(m); mapsByProd.set(m.product_id, a); }
  const chainsOnProd = (pid: string) => new Set((mapsByProd.get(pid) ?? []).map((m) => m.supermarket_id));

  // Index client-EAN products by nameKey (Product A candidates).
  const clientByKey = new Map<string, { id: string; ean: string; name: string }[]>();
  let nClient = 0, nOrphan = 0;
  for (const p of products) {
    const isClient = !!p.ean && clientEans.has(p.ean);
    if (isClient) {
      nClient++;
      const k = nameKey(p.name ?? '', p.brand ?? '');
      if (!k) continue;
      const a = clientByKey.get(k) ?? []; a.push({ id: p.id, ean: p.ean!, name: p.name ?? '' }); clientByKey.set(k, a);
    } else nOrphan++;
  }
  console.log(`Products: ${products.length}  (client-EAN: ${nClient}, orphan/site-EAN or no-EAN: ${nOrphan})`);

  // For each ORPHAN product that has mappings, try to find a client-EAN twin by nameKey.
  interface PlanRow {
    orphanEan: string; orphanName: string; clientEan: string; clientName: string;
    chain: string; active: boolean; conflict: boolean; // conflict = client product already has this chain
  }
  const plan: PlanRow[] = [];
  let orphanWithMaps = 0, orphanMatched = 0;
  const matchedOrphanIds = new Set<string>();
  const recoveredChains = new Set<string>(); // orphanEan::chain that are newly addable
  for (const p of products) {
    const isClient = !!p.ean && clientEans.has(p.ean);
    if (isClient) continue;
    const pm = mapsByProd.get(p.id) ?? [];
    if (pm.length === 0) continue;
    orphanWithMaps++;
    const k = nameKey(p.name ?? '', p.brand ?? '');
    const twins = clientByKey.get(k);
    if (!twins || twins.length === 0) continue;
    const twin = twins[0]!;                    // confident: identical sorted-token key
    orphanMatched++; matchedOrphanIds.add(p.id);
    const twinChains = chainsOnProd(twin.id);
    for (const m of pm) {
      const conflict = twinChains.has(m.supermarket_id);
      if (!conflict) recoveredChains.add(`${p.ean}::${m.supermarket_id}`);
      plan.push({ orphanEan: p.ean ?? '(null)', orphanName: p.name ?? '', clientEan: twin.ean, clientName: twin.name, chain: m.supermarket_id, active: m.is_active, conflict });
    }
  }

  const recoverable = plan.filter((r) => !r.conflict);
  const redundant = plan.filter((r) => r.conflict);
  console.log(`\nOrphan products with mappings: ${orphanWithMaps}`);
  console.log(`  ...with a confident client-EAN twin (same name+brand): ${orphanMatched}`);
  console.log(`\nMappings on matched orphans: ${plan.length}`);
  console.log(`  RECOVERABLE (chain NOT already on client product → re-point + show): ${recoverable.length}`);
  console.log(`     of which currently paused: ${recoverable.filter((r) => !r.active).length}, active: ${recoverable.filter((r) => r.active).length}`);
  console.log(`  REDUNDANT  (chain already on client product → drop/ignore):          ${redundant.length}`);
  console.log(`\nDistinct chains recovered: ${new Set(recoverable.map((r) => r.chain)).size}`);
  const byChain = new Map<string, number>();
  for (const r of recoverable) byChain.set(r.chain, (byChain.get(r.chain) ?? 0) + 1);
  console.log('Recoverable mappings by chain:');
  for (const [c, n] of [...byChain.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${c.padEnd(16)} ${n}`);

  // Are orphan EANs "real"/valid, and are any actually in the client list too?
  let orphanEanInClient = 0, orphanEanNull = 0, orphanEan13 = 0, orphanEanOther = 0;
  for (const id of matchedOrphanIds) {
    const p = products.find((x) => x.id === id)!;
    if (!p.ean) orphanEanNull++;
    else if (clientEans.has(p.ean)) orphanEanInClient++;
    else if (/^\d{13}$/.test(p.ean)) orphanEan13++;
    else orphanEanOther++;
  }
  console.log(`\nMatched-orphan EAN nature: null=${orphanEanNull}, 13-digit=${orphanEan13}, other-len=${orphanEanOther}, actually-in-client-list=${orphanEanInClient}`);

  const esc = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  writeFileSync(OUT, '\uFEFF' + ['Cadena,Accion,EAN_scraper,Nombre_scraper,EAN_cliente,Nombre_cliente,Pausada',
    ...plan.sort((a, b) => Number(b.conflict) - Number(a.conflict)).map((r) => [r.chain, r.conflict ? 'REDUNDANTE' : 'RECUPERABLE', r.orphanEan, r.orphanName, r.clientEan, r.clientName, r.active ? 'no' : 'si'].map(esc).join(','))].join('\r\n') + '\r\n', 'utf8');
  console.log(`\nWrote plan → ${OUT}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
