// TEMP: robust duplicate-EAN audit via fuzzy name+brand match over orphan (non-client-EAN) products. Delete after.
import ExcelJSmod from 'exceljs';
import { db } from '../src/shared/db.js';
import { writeFileSync } from 'node:fs';

const ExcelJS = (ExcelJSmod as unknown as { default?: typeof import('exceljs') }).default ?? ExcelJSmod;
const SHEET = 'C:\\Users\\fran-\\Downloads\\Excel URL unificado (1).xlsx';
const OUT = 'C:\\Users\\fran-\\Downloads\\duplicados_ean_plan.csv';

const cs = (v: unknown): string => v == null ? '' : (typeof v === 'object' ? String((v as { result?: unknown; text?: unknown }).result ?? (v as { text?: unknown }).text ?? '') : String(v)).trim();
const strip = (s: string): string => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
function tokens(name: string, brand: string): Set<string> {
  return new Set(strip(`${brand} ${name}`).replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter((t) => t.length > 1));
}
function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0; for (const t of a) if (b.has(t)) inter++;
  const uni = a.size + b.size - inter; return uni ? inter / uni : 0;
}
async function fetchAll<T>(table: string, cols: string, orderBy: string): Promise<T[]> {
  const all: T[] = []; let off = 0;
  for (;;) { const { data, error } = await db.from(table).select(cols).order(orderBy).range(off, off + 999);
    if (error) throw error; const r = (data ?? []) as unknown as T[]; all.push(...r); if (r.length < 1000) break; off += 1000; }
  return all;
}

async function main(): Promise<void> {
  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(SHEET);
  const ws = wb.getWorksheet('Productos')!;
  const clientEans = new Set<string>();
  for (let r = 2; r <= ws.rowCount; r++) { const e = cs(ws.getRow(r).getCell(2).value).replace(/\D/g, ''); if (e) clientEans.add(e); }

  const products = await fetchAll<{ id: string; ean: string | null; name: string | null; brand: string | null }>('products', 'id, ean, name, brand', 'id');
  const maps = await fetchAll<{ product_id: string; supermarket_id: string; is_active: boolean }>('supermarket_products', 'product_id, supermarket_id, is_active', 'product_id');
  const mapsByProd = new Map<string, { supermarket_id: string; is_active: boolean }[]>();
  for (const m of maps) (mapsByProd.get(m.product_id) ?? mapsByProd.set(m.product_id, []).get(m.product_id)!).push(m);

  const clientProducts = products.filter((p) => p.ean && clientEans.has(p.ean))
    .map((p) => ({ ...p, tok: tokens(p.name ?? '', p.brand ?? '') }));
  const clientChains = new Map<string, { all: Set<string>; active: Set<string> }>();
  for (const p of clientProducts) {
    const all = new Set<string>(), active = new Set<string>();
    for (const m of mapsByProd.get(p.id) ?? []) { all.add(m.supermarket_id); if (m.is_active) active.add(m.supermarket_id); }
    clientChains.set(p.id, { all, active });
  }

  const orphans = products.filter((p) => (!p.ean || !clientEans.has(p.ean)) && (mapsByProd.get(p.id)?.length ?? 0) > 0);

  interface Row { orphanEan: string; orphanName: string; clientEan: string; clientName: string; score: number; tier: string;
    recoverChains: string[]; recoverPaused: number; redundantChains: string[] }
  const rows: Row[] = [];
  const tierCount = new Map<string, number>();
  for (const o of orphans) {
    const ot = tokens(o.name ?? '', o.brand ?? '');
    let best: typeof clientProducts[number] | null = null, bestScore = 0;
    for (const c of clientProducts) { const s = jaccard(ot, c.tok); if (s > bestScore) { bestScore = s; best = c; } }
    const tier = bestScore >= 0.85 ? 'confident' : bestScore >= 0.6 ? 'review' : 'no_match';
    tierCount.set(tier, (tierCount.get(tier) ?? 0) + 1);
    if (!best || tier === 'no_match') { rows.push({ orphanEan: o.ean ?? '(null)', orphanName: o.name ?? '', clientEan: '', clientName: '', score: bestScore, tier, recoverChains: [], recoverPaused: 0, redundantChains: [] }); continue; }
    const cc = clientChains.get(best.id)!;
    const recover: string[] = [], redundant: string[] = []; let paused = 0;
    for (const m of mapsByProd.get(o.id) ?? []) {
      if (cc.active.has(m.supermarket_id)) redundant.push(m.supermarket_id);
      else { recover.push(m.supermarket_id); if (!m.is_active) paused++; }
    }
    rows.push({ orphanEan: o.ean ?? '(null)', orphanName: o.name ?? '', clientEan: best.ean!, clientName: best.name ?? '', score: bestScore, tier, recoverChains: recover, recoverPaused: paused, redundantChains: redundant });
  }

  console.log(`Client-EAN products: ${clientProducts.length}   Orphan products (non-client EAN) with mappings: ${orphans.length}`);
  console.log('\nMatch tiers:');
  for (const [k, n] of [...tierCount.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(12)} ${n}`);
  const matched = rows.filter((r) => r.tier !== 'no_match');
  const recoverTotal = matched.reduce((s, r) => s + r.recoverChains.length, 0);
  const recoverPaused = matched.reduce((s, r) => s + r.recoverPaused, 0);
  console.log(`\nOn confident+review matches:`);
  console.log(`  mappings recoverable (chain not already active on client product): ${recoverTotal}  (paused: ${recoverPaused})`);
  console.log(`  redundant (client product already active at that chain):          ${matched.reduce((s, r) => s + r.redundantChains.length, 0)}`);

  // EAN nature of orphans
  let e13 = 0, eNull = 0, eOther = 0;
  for (const o of orphans) { if (!o.ean) eNull++; else if (/^\d{13}$/.test(o.ean)) e13++; else eOther++; }
  console.log(`\nOrphan EAN nature: 13-digit=${e13}, null=${eNull}, other-length=${eOther}`);

  const esc = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  writeFileSync(OUT, '\uFEFF' + ['Tier,Score,EAN_scraper,Nombre_scraper,EAN_cliente,Nombre_cliente,Cadenas_recuperables,Pausadas,Cadenas_redundantes',
    ...rows.sort((a, b) => b.score - a.score).map((r) => [r.tier, r.score.toFixed(2), r.orphanEan, r.orphanName, r.clientEan, r.clientName, r.recoverChains.join(' '), String(r.recoverPaused), r.redundantChains.join(' ')].map(esc).join(','))].join('\r\n') + '\r\n', 'utf8');
  console.log(`\nWrote plan → ${OUT}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
