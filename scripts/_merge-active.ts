// Merge LLM-confirmed duplicate rows onto their client-EAN twin — ACTIVE mappings only (no reactivation).
// Dry-run by default; pass --apply to write. Verdicts are cached in scripts/_verdicts.json (--refresh to redo LLM).
import ExcelJSmod from 'exceljs';
import { db } from '../src/shared/db.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { judgeEanMatches, type JudgeItem, type JudgeVerdict } from '../src/discovery/eanJudge.js';
import type { EanSuggestion, MatchConfidence } from '../src/discovery/eanMatch.js';
import { getCatalogEans } from '../src/shared/catalog.js';

const ExcelJS = (ExcelJSmod as unknown as { default?: typeof import('exceljs') }).default ?? ExcelJSmod;

const CACHE = 'scripts/_verdicts.json';
const MIN_CONF = 0.9; // high bar for a DB mutation

const strip = (s: string): string => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
function toks(name: string, brand: string): Set<string> { return new Set(strip(`${brand} ${name}`).replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter((t) => t.length > 1)); }
function jaccard(a: Set<string>, b: Set<string>): number { let i = 0; for (const t of a) if (b.has(t)) i++; const u = a.size + b.size - i; return u ? i / u : 0; }

// --- size / variety guards (used to hold ambiguous reactivation candidates) ---
const VUNIT = /(\d+(?:[.,]\d+)?)\s*(ml|cc|lts?|litros?|l|kgrs?|kg|grs?|gr|g)\b/gi;
/** Largest volume (ml) and mass (g) found in a name; thousands-sep aware ("1.500ml"→1500). */
function measures(name: string): { vol: number | null; mass: number | null } {
  let vol: number | null = null, mass: number | null = null;
  for (const m of strip(name).matchAll(VUNIT)) {
    const raw = m[1]!; const unit = m[2]!;
    const n = /^\d+\.\d{3}$/.test(raw) ? parseFloat(raw.replace('.', '')) : parseFloat(raw.replace(',', '.'));
    if (/^(l|lt|lts|litro|litros)$/.test(unit)) vol = Math.max(vol ?? 0, n * 1000);
    else if (unit === 'cc' || unit === 'ml') vol = Math.max(vol ?? 0, n);
    else if (/^(kg|kgr|kgrs)$/.test(unit)) mass = Math.max(mass ?? 0, n * 1000);
    else if (/^(g|gr|grs)$/.test(unit)) mass = Math.max(mass ?? 0, n);
  }
  return { vol, mass };
}
/** True if both names carry the same measure family but the values disagree (>3%). */
function volumeMismatch(a: string, b: string): boolean {
  const ma = measures(a), mb = measures(b);
  const diff = (x: number | null, y: number | null): boolean => x != null && y != null && Math.abs(x - y) / Math.max(x, y) > 0.03;
  return diff(ma.vol, mb.vol) || diff(ma.mass, mb.mass);
}
const VARIETY = ['lavanda', 'marina', 'primavera', 'floral', 'original', 'bebe', 'coco', 'tropical', 'tropicales', 'rosa', 'pink', 'multiuso', 'expert', 'splash', 'citrus', 'limon', 'oceano', 'blanco', 'color', 'antibacterial', 'desinfectante', 'nature', 'natural'];
function varietyWords(name: string): Set<string> { const s = strip(name); return new Set(VARIETY.filter((w) => new RegExp(`\\b${w}`).test(s))); }
/** True if both names mention variety words but share none (likely different fragrance/variant). */
function varietyMismatch(a: string, b: string): boolean {
  const va = varietyWords(a), vb = varietyWords(b);
  if (!va.size || !vb.size) return false;
  for (const w of va) if (vb.has(w)) return false;
  return true;
}
async function fetchAll<T>(table: string, cols: string, orderBy: string): Promise<T[]> {
  const all: T[] = []; let off = 0;
  for (;;) { const { data, error } = await db.from(table).select(cols).order(orderBy).range(off, off + 999);
    if (error) throw error; const r = (data ?? []) as unknown as T[]; all.push(...r); if (r.length < 1000) break; off += 1000; }
  return all;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const refresh = process.argv.includes('--refresh');
  const sheet = process.argv.includes('--sheet');
  const reactivate = process.argv.includes('--reactivate');

  // Authoritative client universe = hardcoded 211 ∪ catalog_extra_eans (NOT the URL sheet).
  const catalog = await getCatalogEans();
  const clientEans = new Set(catalog.keys());
  console.log(`Client universe (authoritative catalog): ${clientEans.size} EANs`);

  const sups = await fetchAll<{ id: string; is_active: boolean }>('supermarkets', 'id, is_active', 'id');
  const chainActive = new Map(sups.map((s) => [s.id, s.is_active]));
  const products = await fetchAll<{ id: string; ean: string | null; name: string | null; brand: string | null }>('products', 'id, ean, name, brand', 'id');
  const maps = await fetchAll<{ id: string; product_id: string; supermarket_id: string; is_active: boolean; external_url: string | null }>('supermarket_products', 'id, product_id, supermarket_id, is_active, external_url', 'product_id');
  const mapsByProd = new Map<string, typeof maps>();
  for (const m of maps) (mapsByProd.get(m.product_id) ?? mapsByProd.set(m.product_id, []).get(m.product_id)!).push(m);

  const clientProducts = products.filter((p) => p.ean && clientEans.has(p.ean)).map((p) => ({ id: p.id, ean: p.ean!, name: p.name ?? '', tok: toks(p.name ?? '', p.brand ?? '') }));
  const clientByEan = new Map(clientProducts.map((c) => [c.ean, c]));
  const clientChainStates = new Map<string, Map<string, boolean>>(); // clientEan -> chain -> anyActive
  for (const c of clientProducts) { const m = new Map<string, boolean>(); for (const mp of mapsByProd.get(c.id) ?? []) m.set(mp.supermarket_id, (m.get(mp.supermarket_id) ?? false) || mp.is_active); clientChainStates.set(c.ean, m); }

  const orphans = products.filter((p) => (!p.ean || !clientEans.has(p.ean)) && (mapsByProd.get(p.id)?.length ?? 0) > 0);

  // ---- verdicts (cached) ----
  let verdicts: Map<string, JudgeVerdict>;
  if (!refresh && existsSync(CACHE)) {
    const obj = JSON.parse(readFileSync(CACHE, 'utf8')) as Record<string, JudgeVerdict>;
    verdicts = new Map(Object.entries(obj));
    console.log(`Loaded ${verdicts.size} cached verdicts (${CACHE}). Use --refresh to redo the LLM.`);
  } else {
    const conf = (s: number): MatchConfidence => (s >= 0.7 ? 'high' : s >= 0.45 ? 'medium' : 'low');
    const items: JudgeItem[] = orphans.map((o) => {
      const ot = toks(o.name ?? '', o.brand ?? '');
      const cands: EanSuggestion[] = clientProducts.map((c) => ({ ean: c.ean, score: Number(jaccard(ot, c.tok).toFixed(3)), confidence: conf(jaccard(ot, c.tok)), description: c.name }))
        .filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 5);
      const url = (mapsByProd.get(o.id) ?? []).find((m) => m.external_url)?.external_url ?? null;
      return { id: o.id, name: o.name ?? '', url, supermarket: (mapsByProd.get(o.id) ?? [])[0]?.supermarket_id ?? null, candidates: cands };
    });
    console.log(`Judging ${items.length} orphans via LLM...`);
    verdicts = await judgeEanMatches(items, { batchSize: 12, onProgress: (d, t) => process.stdout.write(`\r  ${d}/${t}`) });
    process.stdout.write('\n');
    writeFileSync(CACHE, JSON.stringify(Object.fromEntries(verdicts), null, 2), 'utf8');
    console.log(`Cached verdicts → ${CACHE}`);
  }

  // ---- classify each mapping of each confirmed orphan ----
  interface Op { mappingId: string; chain: string; siteEan: string; clientEan: string; clientProductId: string; conf: number }
  const repoint: Op[] = [];        // active + client twin NOT active here → re-point (no reactivation)
  const dedupe: Op[] = [];         // active + client twin ALREADY active here → duplicate export row (deactivate orphan)
  let skippedPaused = 0, lowConf = 0, noTwin = 0;
  let pausedOnLiveChain = 0, pausedOnDeadChain = 0;              // paused confirmed twins: would help client only if reactivated
  // Recoverable-by-reactivation candidates: paused mapping on a LIVE chain, confirmed twin, client EAN NOT already active there.
  const reactivateCands: { mappingId: string; chain: string; siteEan: string; siteName: string; url: string; clientEan: string; clientDesc: string; conf: number }[] = [];
  const orphanById = new Map(orphans.map((o) => [o.id, o]));

  for (const [id, v] of verdicts) {
    const o = orphanById.get(id); if (!o) continue;
    if (!v.ean || !clientByEan.has(v.ean)) { noTwin++; continue; }
    if (v.confidence < MIN_CONF) { lowConf++; continue; }
    const twin = clientByEan.get(v.ean)!;
    const twinChains = clientChainStates.get(v.ean) ?? new Map();
    for (const m of mapsByProd.get(id) ?? []) {
      if (!m.is_active) {                                        // never reactivate here — but measure + collect impact
        skippedPaused++;
        const twinActiveHere = twinChains.get(m.supermarket_id) === true;
        if (chainActive.get(m.supermarket_id) && !twinActiveHere) {
          pausedOnLiveChain++;
          reactivateCands.push({ mappingId: m.id, chain: m.supermarket_id, siteEan: o.ean ?? '(null)', siteName: o.name, url: m.external_url ?? '', clientEan: v.ean, clientDesc: twin.name, conf: v.confidence });
        } else pausedOnDeadChain++;
        continue;
      }
      const twinActiveHere = twinChains.get(m.supermarket_id) === true;
      const op: Op = { mappingId: m.id, chain: m.supermarket_id, siteEan: o.ean ?? '(null)', clientEan: v.ean, clientProductId: twin.id, conf: v.confidence };
      if (twinActiveHere) dedupe.push(op); else repoint.push(op);
    }
  }
  const repointLive = repoint.filter((r) => chainActive.get(r.chain));
  const repointDead = repoint.length - repointLive.length;

  console.log(`\n=== NO-REACTIVATION MERGE PLAN (confidence ≥ ${MIN_CONF}) ===`);
  console.log(`Re-point active mappings onto client EAN (barcode fix, stays active): ${repoint.length}`);
  console.log(`   → on a LIVE chain (client-visible win): ${repointLive.length}   on a dead/paused chain (no export effect): ${repointDead}`);
  const byChain = new Map<string, number>();
  for (const r of repoint) byChain.set(r.chain, (byChain.get(r.chain) ?? 0) + 1);
  for (const [c, n] of [...byChain.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${c.padEnd(16)} ${n} ${chainActive.get(c) ? '' : '(chain DEACTIVATED)'}`);
  console.log(`Active DUPLICATES where client EAN already active there (would deactivate orphan): ${dedupe.length}`);
  console.log(`\nSkipped — paused (no reactivation): ${skippedPaused}`);
  console.log(`   → of those, confirmed twins on a LIVE chain (would become client-visible IF reactivated): ${pausedOnLiveChain}`);
  console.log(`   → on a dead/paused chain (reactivation wouldn't help anyway):                            ${pausedOnDeadChain}`);
  console.log(`below conf: ${lowConf}   no client twin: ${noTwin}`);
  console.log('\nRe-point (LIVE chains only):');
  for (const r of repointLive) console.log(`  ${r.chain.padEnd(14)} ${r.siteEan} → ${r.clientEan} (conf ${r.conf}) map=${r.mappingId}`);
  console.log('Dedupe (deactivate site-EAN row; client twin already active here):');
  for (const r of dedupe) console.log(`  ${r.chain.padEnd(14)} ${r.siteEan} → twin ${r.clientEan} (conf ${r.conf}) map=${r.mappingId}`);

  // ---- Coverage: which ACTIVE non-catalog mappings on LIVE chains will the plan clear? ----
  const covered = new Set([...repointLive, ...dedupe.filter((d) => chainActive.get(d.chain))].map((o) => o.mappingId));
  const offenders = maps.filter((m) => {
    if (!m.is_active || !chainActive.get(m.supermarket_id)) return false;
    const p = products.find((x) => x.id === m.product_id);
    return !p?.ean || !clientEans.has(p.ean);
  });
  const uncovered = offenders.filter((m) => !covered.has(m.id));
  console.log(`\nActive non-catalog mappings on LIVE chains (export offenders): ${offenders.length}  covered by plan: ${offenders.length - uncovered.length}  UNCOVERED: ${uncovered.length}`);
  for (const m of uncovered.slice(0, 20)) { const p = products.find((x) => x.id === m.product_id); console.log(`  UNCOVERED ${m.supermarket_id.padEnd(14)} ean=${p?.ean ?? '(null)'} "${p?.name ?? ''}" map=${m.id}`); }

  // ---- Reactivation review sheet: paused-on-live-chain confirmed twins (the real "missing products"). ----
  console.log(`\nRecoverable-by-reactivation candidates (paused, live chain, confirmed client twin): ${reactivateCands.length}`);
  const byChainR = new Map<string, number>();
  for (const r of reactivateCands) byChainR.set(r.chain, (byChainR.get(r.chain) ?? 0) + 1);
  for (const [c, n] of [...byChainR.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${c.padEnd(16)} ${n}`);

  // ---- Split candidates into SAFE (clean 1:1) vs HELD (ambiguous — need a human). ----
  const groupCount = new Map<string, number>();                          // (chain|clientEan) -> #site rows
  for (const r of reactivateCands) { const k = `${r.chain}|${r.clientEan}`; groupCount.set(k, (groupCount.get(k) ?? 0) + 1); }
  type Reason = 'collision' | 'volume' | 'variety';
  const heldReason = (r: (typeof reactivateCands)[number]): Reason | null => {
    if ((groupCount.get(`${r.chain}|${r.clientEan}`) ?? 0) > 1) return 'collision';
    if (volumeMismatch(r.clientDesc, r.siteName)) return 'volume';
    if (varietyMismatch(r.clientDesc, r.siteName)) return 'variety';
    return null;
  };
  const held = reactivateCands.map((r) => ({ r, reason: heldReason(r) })).filter((x) => x.reason) as { r: (typeof reactivateCands)[number]; reason: Reason }[];
  const safe = reactivateCands.filter((r) => !heldReason(r));
  console.log(`\nSAFE (clean 1:1, auto-apply): ${safe.length}   HELD (needs review): ${held.length}`);
  const heldBy = new Map<Reason, number>();
  for (const h of held) heldBy.set(h.reason, (heldBy.get(h.reason) ?? 0) + 1);
  for (const [rz, n] of heldBy) console.log(`    ${rz}: ${n}`);

  if (sheet) {
    const wb = new ExcelJS.Workbook();
    const wsH = wb.addWorksheet('Revisar');
    wsH.addRow(['MOTIVO', 'CADENA', 'EAN_CLIENTE', 'DESC_CLIENTE', 'EAN_SITIO', 'NOMBRE_SITIO', 'CONFIANZA', 'URL', 'mapping_id']).font = { bold: true };
    for (const h of held.sort((a, b) => a.reason.localeCompare(b.reason) || a.r.chain.localeCompare(b.r.chain) || a.r.clientEan.localeCompare(b.r.clientEan)))
      wsH.addRow([h.reason, h.r.chain, h.r.clientEan, h.r.clientDesc, h.r.siteEan, h.r.siteName, h.r.conf, h.r.url, h.r.mappingId]);
    wsH.columns = [{ width: 10 }, { width: 16 }, { width: 15 }, { width: 40 }, { width: 15 }, { width: 44 }, { width: 10 }, { width: 50 }, { width: 38 }];
    wsH.views = [{ state: 'frozen', ySplit: 1 }];
    const wsS = wb.addWorksheet('Aplicados');
    wsS.addRow(['CADENA', 'EAN_CLIENTE', 'DESC_CLIENTE', 'EAN_SITIO', 'NOMBRE_SITIO', 'mapping_id']).font = { bold: true };
    for (const r of safe) wsS.addRow([r.chain, r.clientEan, r.clientDesc, r.siteEan, r.siteName, r.mappingId]);
    const out = `C:\\Users\\fran-\\Downloads\\reactivar-revisar_${new Date().toISOString().slice(0, 10)}.xlsx`;
    await wb.xlsx.writeFile(out);
    console.log(`Review sheet → ${out}  (Revisar: ${held.length}, Aplicados: ${safe.length})`);
  }

  if (reactivate) {
    const target = process.argv.includes('--all') ? reactivateCands : safe;   // default: SAFE only
    let rOk = 0, rFail = 0;
    for (const r of target) {
      const { error } = await db.from('supermarket_products')
        .update({ product_id: clientByEan.get(r.clientEan)!.id, is_active: true, lifecycle_status: 'active' })
        .eq('id', r.mappingId);
      if (error) { rFail++; console.error(`  FAIL ${r.mappingId}: ${error.message}`); } else rOk++;
    }
    console.log(`\nReactivated + re-pointed ${rOk}/${target.length} mappings onto client EANs (${rFail} failed). ${process.argv.includes('--all') ? '(ALL)' : `(SAFE only; ${held.length} held)`}`);
    process.exit(0);
  }

  if (!apply) { console.log('\nDry-run. Flags: --sheet (safe/held xlsx) | --reactivate (apply SAFE set) | --reactivate --all (apply everything) | --apply (live barcode repoints only).'); process.exit(0); }

  // ---- APPLY: LIVE-chain repoints (product_id swap, stays active) + LIVE-chain dedupes (deactivate site-EAN row). ----
  let ok = 0, fail = 0;
  for (const r of repointLive) {
    const { error } = await db.from('supermarket_products').update({ product_id: r.clientProductId }).eq('id', r.mappingId);
    if (error) { fail++; console.error(`  FAIL repoint ${r.mappingId}: ${error.message}`); } else ok++;
  }
  let ddOk = 0;
  for (const r of dedupe.filter((d) => chainActive.get(d.chain))) {
    const { error } = await db.from('supermarket_products').update({ is_active: false }).eq('id', r.mappingId);
    if (error) { fail++; console.error(`  FAIL dedupe ${r.mappingId}: ${error.message}`); } else ddOk++;
  }
  console.log(`\nRe-pointed ${ok}/${repointLive.length} live mappings, deactivated ${ddOk} duplicate site-EAN rows (${fail} failed). mercadolibre + paused untouched.`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
