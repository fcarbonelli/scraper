// TEMP: URL-based duplicate-EAN audit. The client's URL sheet maps client-EAN → exact store page;
// we join that to our existing mappings to find pages bound to a DIFFERENT (site) EAN. Delete after.
import ExcelJSmod from 'exceljs';
import { db } from '../src/shared/db.js';
import { writeFileSync } from 'node:fs';

const ExcelJS = (ExcelJSmod as unknown as { default?: typeof import('exceljs') }).default ?? ExcelJSmod;
const SHEET = 'C:\\Users\\fran-\\Downloads\\Excel URL unificado (1).xlsx';
const OUT = 'C:\\Users\\fran-\\Downloads\\duplicados_ean_plan.csv';

const cs = (v: unknown): string => v == null ? '' : (typeof v === 'object' ? String((v as { result?: unknown; text?: unknown }).result ?? (v as { text?: unknown }).text ?? '') : String(v)).trim();
function extractUrl(cell: { value: unknown; hyperlink?: string }): string {
  const v = cell.value as unknown; let u = '';
  if (v && typeof v === 'object') { const o = v as Record<string, unknown>; u = String(o.hyperlink ?? o.text ?? '').trim(); }
  else if (typeof v === 'string') u = v.trim();
  if (!u && cell.hyperlink) u = String(cell.hyperlink).trim();
  return /^https?:\/\//i.test(u) ? u : '';
}
function normUrl(u: string): string {
  try { const x = new URL(u); return (x.host + decodeURIComponent(x.pathname)).toLowerCase().replace(/\/+$/, ''); }
  catch { return u.toLowerCase().replace(/\/+$/, ''); }
}
async function fetchAll<T>(table: string, cols: string, orderBy: string): Promise<T[]> {
  const all: T[] = []; let off = 0;
  for (;;) { const { data, error } = await db.from(table).select(cols).order(orderBy).range(off, off + 999);
    if (error) throw error; const r = (data ?? []) as unknown as T[]; all.push(...r); if (r.length < 1000) break; off += 1000; }
  return all;
}

async function main(): Promise<void> {
  // ---- client sheet: normURL → {clientEan, name} ----
  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(SHEET);
  const ws = wb.getWorksheet('Productos')!;
  const urlToClient = new Map<string, { ean: string; name: string }>();
  const clientEans = new Set<string>();
  for (let r = 2; r <= ws.rowCount; r++) {
    const ean = cs(ws.getRow(r).getCell(2).value).replace(/\D/g, ''); if (ean) clientEans.add(ean);
    const url = extractUrl(ws.getRow(r).getCell(7) as unknown as { value: unknown; hyperlink?: string });
    if (url && ean) urlToClient.set(normUrl(url), { ean, name: cs(ws.getRow(r).getCell(3).value).replace(/\s+/g, ' ') });
  }
  console.log(`Sheet: ${urlToClient.size} distinct client URLs, ${clientEans.size} client EANs.`);

  // ---- our data ----
  const products = await fetchAll<{ id: string; ean: string | null; name: string | null }>('products', 'id, ean, name', 'id');
  const prodById = new Map(products.map((p) => [p.id, p]));
  const clientEanToProduct = new Map<string, { id: string; name: string | null }>();
  for (const p of products) if (p.ean && clientEans.has(p.ean)) clientEanToProduct.set(p.ean, { id: p.id, name: p.name });
  const maps = await fetchAll<{ id: string; product_id: string; supermarket_id: string; is_active: boolean; external_url: string | null }>(
    'supermarket_products', 'id, product_id, supermarket_id, is_active, external_url', 'product_id');
  const chainsOfProduct = new Map<string, Set<string>>();      // product_id → chains it's mapped at
  const activeChainOfProduct = new Map<string, Set<string>>(); // product_id → chains where active
  for (const m of maps) {
    (chainsOfProduct.get(m.product_id) ?? chainsOfProduct.set(m.product_id, new Set()).get(m.product_id)!).add(m.supermarket_id);
    if (m.is_active) (activeChainOfProduct.get(m.product_id) ?? activeChainOfProduct.set(m.product_id, new Set()).get(m.product_id)!).add(m.supermarket_id);
  }

  // ---- join our mappings to client URLs ----
  interface Row { chain: string; mappingId: string; ourEan: string; ourName: string; clientEan: string; clientName: string; active: boolean; action: string }
  const rows: Row[] = [];
  for (const m of maps) {
    if (!m.external_url) continue;
    const c = urlToClient.get(normUrl(m.external_url));
    if (!c) continue;                                  // this store page isn't in the client sheet
    const our = prodById.get(m.product_id);
    const ourEan = our?.ean ?? '(null)';
    if (ourEan === c.ean) continue;                    // already on the client EAN — fine
    // MISMATCH: this exact store page is bound to a different EAN than the client's.
    const twin = clientEanToProduct.get(c.ean);
    let action: string;
    if (!twin) action = 'RELABEL_TO_CLIENT_EAN';       // no client-EAN product row exists → set this product's EAN
    else if ((activeChainOfProduct.get(twin.id) ?? new Set()).has(m.supermarket_id)) action = 'REDUNDANT';   // client product already active here
    else action = 'REPOINT_TO_CLIENT_PRODUCT';         // move this mapping onto the client-EAN product
    rows.push({ chain: m.supermarket_id, mappingId: m.id, ourEan, ourName: our?.name ?? '', clientEan: c.ean, clientName: c.name, active: m.is_active, action });
  }

  const byAction = new Map<string, number>();
  for (const r of rows) byAction.set(r.action, (byAction.get(r.action) ?? 0) + 1);
  console.log(`\nStore pages bound to a DIFFERENT EAN than the client's: ${rows.length}`);
  for (const [k, n] of [...byAction.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(26)} ${n}`);
  console.log(`\n  currently paused: ${rows.filter((r) => !r.active).length}, active: ${rows.filter((r) => r.active).length}`);
  const byChain = new Map<string, number>();
  for (const r of rows) byChain.set(r.chain, (byChain.get(r.chain) ?? 0) + 1);
  console.log('\nBy chain:');
  for (const [c, n] of [...byChain.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${c.padEnd(16)} ${n}`);

  // Distinct EAN pairs (are the site EANs valid 13-digit? in client list?)
  const pairs = new Map<string, { ourEan: string; clientEan: string; name: string }>();
  for (const r of rows) pairs.set(`${r.ourEan}=>${r.clientEan}`, { ourEan: r.ourEan, clientEan: r.clientEan, name: r.clientName });
  let ean13 = 0, eanNull = 0, eanOther = 0, eanInClient = 0;
  for (const p of pairs.values()) {
    if (p.ourEan === '(null)') eanNull++;
    else if (clientEans.has(p.ourEan)) eanInClient++;
    else if (/^\d{13}$/.test(p.ourEan)) ean13++;
    else eanOther++;
  }
  console.log(`\nDistinct (siteEAN→clientEAN) pairs: ${pairs.size}`);
  console.log(`  site EANs: 13-digit=${ean13}, null=${eanNull}, other-length=${eanOther}, also-in-client-list=${eanInClient}`);

  const esc = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  writeFileSync(OUT, '\uFEFF' + ['Cadena,Accion,Pausada,EAN_scraper,Nombre_scraper,EAN_cliente,Nombre_cliente,MappingId',
    ...rows.sort((a, b) => a.action.localeCompare(b.action) || a.chain.localeCompare(b.chain))
      .map((r) => [r.chain, r.action, r.active ? 'no' : 'si', r.ourEan, r.ourName, r.clientEan, r.clientName, r.mappingId].map(esc).join(','))].join('\r\n') + '\r\n', 'utf8');
  console.log(`\nWrote plan → ${OUT}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
