// TEMP (read-only): reconcile orphan (non-client-EAN) product rows to their client-EAN twin,
// using token candidates + the existing LLM judge to adjudicate brand/variety/size. Writes a plan; no DB writes.
import ExcelJSmod from 'exceljs';
import { db } from '../src/shared/db.js';
import { writeFileSync } from 'node:fs';
import { judgeEanMatches, type JudgeItem } from '../src/discovery/eanJudge.js';
import type { EanSuggestion, MatchConfidence } from '../src/discovery/eanMatch.js';

const ExcelJS = (ExcelJSmod as unknown as { default?: typeof import('exceljs') }).default ?? ExcelJSmod;
const SHEET = 'C:\\Users\\fran-\\Downloads\\Excel URL unificado (1).xlsx';
const OUT = 'C:\\Users\\fran-\\Downloads\\reconciliacion_ean_plan.csv';

const cs = (v: unknown): string => v == null ? '' : (typeof v === 'object' ? String((v as { result?: unknown; text?: unknown }).result ?? (v as { text?: unknown }).text ?? '') : String(v)).trim();
const strip = (s: string): string => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
function toks(name: string, brand: string): Set<string> {
  return new Set(strip(`${brand} ${name}`).replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter((t) => t.length > 1));
}
function jaccard(a: Set<string>, b: Set<string>): number { let i = 0; for (const t of a) if (b.has(t)) i++; const u = a.size + b.size - i; return u ? i / u : 0; }
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
  const maps = await fetchAll<{ product_id: string; supermarket_id: string; is_active: boolean; external_url: string | null }>('supermarket_products', 'product_id, supermarket_id, is_active, external_url', 'product_id');
  const mapsByProd = new Map<string, typeof maps>();
  for (const m of maps) (mapsByProd.get(m.product_id) ?? mapsByProd.set(m.product_id, []).get(m.product_id)!).push(m);

  const clientProducts = products.filter((p) => p.ean && clientEans.has(p.ean)).map((p) => ({ id: p.id, ean: p.ean!, name: p.name ?? '', tok: toks(p.name ?? '', p.brand ?? '') }));
  const clientByEan = new Map(clientProducts.map((c) => [c.ean, c]));
  const clientActiveChains = new Map<string, Set<string>>();
  for (const c of clientProducts) { const a = new Set<string>(); for (const m of mapsByProd.get(c.id) ?? []) if (m.is_active) a.add(m.supermarket_id); clientActiveChains.set(c.ean, a); }

  const orphans = products.filter((p) => (!p.ean || !clientEans.has(p.ean)) && (mapsByProd.get(p.id)?.length ?? 0) > 0);

  // Build judge items: top-5 client-EAN candidates per orphan.
  const conf = (s: number): MatchConfidence => (s >= 0.7 ? 'high' : s >= 0.45 ? 'medium' : 'low');
  const items: JudgeItem[] = [];
  const orphanById = new Map(orphans.map((o) => [o.id, o]));
  for (const o of orphans) {
    const ot = toks(o.name ?? '', o.brand ?? '');
    const scored = clientProducts.map((c) => ({ c, s: jaccard(ot, c.tok) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 5);
    const candidates: EanSuggestion[] = scored.map((x) => ({ ean: x.c.ean, score: Number(x.s.toFixed(3)), confidence: conf(x.s), description: x.c.name }));
    const url = (mapsByProd.get(o.id) ?? []).find((m) => m.external_url)?.external_url ?? null;
    const sup = (mapsByProd.get(o.id) ?? [])[0]?.supermarket_id ?? null;
    items.push({ id: o.id, name: o.name ?? '', url, supermarket: sup, candidates });
  }

  console.log(`Judging ${items.length} orphan products against client-EAN candidates via LLM...`);
  const verdicts = await judgeEanMatches(items, { batchSize: 12, onProgress: (d, t) => process.stdout.write(`\r  ${d}/${t}`) });
  process.stdout.write('\n');

  // Build the merge plan from confident verdicts.
  interface PlanRow { orphanEan: string; orphanName: string; clientEan: string; clientName: string; conf: number; reason: string; recover: string[]; recoverPaused: number; redundant: string[] }
  const plan: PlanRow[] = []; let noMatch = 0;
  for (const [id, v] of verdicts) {
    const o = orphanById.get(id)!;
    if (!v.ean || !clientByEan.has(v.ean) || v.confidence < 0.6) { noMatch++; continue; }
    const twin = clientByEan.get(v.ean)!;
    const active = clientActiveChains.get(v.ean) ?? new Set<string>();
    const recover: string[] = [], redundant: string[] = []; let paused = 0;
    for (const m of mapsByProd.get(id) ?? []) {
      if (active.has(m.supermarket_id)) redundant.push(m.supermarket_id);
      else { recover.push(m.supermarket_id); if (!m.is_active) paused++; }
    }
    plan.push({ orphanEan: o.ean ?? '(null)', orphanName: o.name ?? '', clientEan: v.ean, clientName: twin.name, conf: v.confidence, reason: v.reason, recover, recoverPaused: paused, redundant });
  }

  const recoverTotal = plan.reduce((s, r) => s + r.recover.length, 0);
  const recoverPaused = plan.reduce((s, r) => s + r.recoverPaused, 0);
  console.log(`\nLLM matched to a client EAN: ${plan.length} orphans   |   no confident match: ${noMatch}`);
  console.log(`Recoverable mappings (chain not already active on client twin): ${recoverTotal}  (paused: ${recoverPaused}, active: ${recoverTotal - recoverPaused})`);
  console.log(`Redundant mappings (client twin already active there):          ${plan.reduce((s, r) => s + r.redundant.length, 0)}`);
  const byChain = new Map<string, number>();
  for (const r of plan) for (const c of r.recover) byChain.set(c, (byChain.get(c) ?? 0) + 1);
  console.log('\nRecoverable mappings by chain:');
  for (const [c, n] of [...byChain.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${c.padEnd(16)} ${n}`);

  console.log('\nExamples:');
  for (const r of plan.slice(0, 6)) console.log(`  ${r.orphanEan} "${r.orphanName.slice(0, 40)}" → ${r.clientEan} (conf ${r.conf}) recover=[${r.recover.join(',')}] :: ${r.reason.slice(0, 70)}`);

  const esc = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  writeFileSync(OUT, '\uFEFF' + ['Confianza,EAN_scraper,Nombre_scraper,EAN_cliente,Nombre_cliente,Cadenas_recuperables,Pausadas,Cadenas_redundantes,Razon',
    ...plan.sort((a, b) => b.conf - a.conf).map((r) => [r.conf.toFixed(2), r.orphanEan, r.orphanName, r.clientEan, r.clientName, r.recover.join(' '), String(r.recoverPaused), r.redundant.join(' '), r.reason].map(esc).join(','))].join('\r\n') + '\r\n', 'utf8');
  console.log(`\nWrote reconciliation plan → ${OUT}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
