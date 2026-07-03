/**
 * Heal EAN-less products (one-time backlog cleanup).
 *
 * WHAT IT FIXES
 * -------------
 * Products ingested from EAN-less sites (Coto, etc.) without binding a catalog
 * EAN sit as orphan master rows (`ean = NULL`, no taxonomy). They export to
 * client_base with blank EAN / Categoria / Marca … and never dedupe with the
 * "real" master. See docs/PRODUCT_MANAGEMENT.md.
 *
 * We DON'T have a stored link from each orphan to the catalog EAN the operator
 * originally intended, so this can't be fully automatic. Instead it RANKS catalog
 * EANs per orphan (shared matcher in src/discovery/eanMatch.ts — name/brand token
 * overlap against the catalog + the scraped names of sibling products that
 * already carry each EAN) and tags each with a confidence (high/medium/low).
 * Binding re-points the mapping to the canonical master + enriches from the
 * catalog (price history preserved) via src/ingest/bindEan.ts.
 *
 * WORKFLOW (run once)
 * -------------------
 *   1. Report + write a review CSV:
 *        npm run heal:eans
 *      → prints the backlog with a confidence breakdown and writes heal-eans.csv.
 *        HIGH-confidence rows are pre-filled in `confirm_ean`; the rest are blank.
 *
 *   2. Eyeball the CSV (the `url` column makes each row easy to verify). Fix any
 *      pre-filled row you disagree with; fill `confirm_ean` for the medium/low
 *      ones you recognise; leave blank to skip.
 *
 *   3. Apply your curated file:
 *        npm run heal:eans -- --apply=heal-eans.csv
 *
 * FAST PATH (little/no manual work)
 *   --auto                Skip the CSV: auto-bind every HIGH-confidence match,
 *                         skip the rest (review those later).
 *   --auto-confidence=medium   Lower the auto bar to medium (more coverage, more risk).
 *   --auto --min-score=0.6     Use a raw score threshold instead of confidence.
 *
 * LLM JUDGE (resolves the ambiguous medium/low band automatically)
 *   --judge               Ask the LLM (REVISTA_JUDGE_MODEL) to adjudicate every
 *                         not-high orphan that has candidates. High token matches
 *                         are trusted as-is. Writes the CSV with confirm_ean
 *                         pre-filled for high + LLM-confirmed rows.
 *   --judge --auto        Judge AND bind (high + LLM-confirmed) in one shot.
 *   --judge-threshold=0.7 Min LLM confidence to accept a judged match (default 0.7).
 *
 * OTHER FLAGS
 *   --use-suggested       On --apply, fall back to `suggested_ean` when `confirm_ean` is blank.
 *   --out=FILE            Report CSV path (default: heal-eans.csv).
 *   --limit=N             Only process the first N orphan mappings.
 */

import { writeFileSync, readFileSync } from 'node:fs';
import { db } from '../src/shared/db.js';
import { bindMappingToEan } from '../src/ingest/bindEan.js';
import {
  buildEanIndex,
  suggestEansFromIndex,
  type MatchConfidence,
} from '../src/discovery/eanMatch.js';
import { judgeEanMatches, type JudgeItem, type JudgeVerdict } from '../src/discovery/eanJudge.js';
import { revistaConfig } from '../src/revistas/config.js';

/** One orphan supermarket_products mapping that needs an EAN. */
interface Orphan {
  supermarketProductId: string;
  supermarketId: string;
  url: string;
  productName: string;
  brand: string | null;
}

interface Suggestion {
  ean: string;
  score: number;
  confidence: MatchConfidence;
  description: string;
}

const NO_MATCH: Suggestion = { ean: '', score: 0, confidence: 'low', description: '' };

// Portable invocation for the printed hints. `npm run … -- <flags>` drops the
// flags under PowerShell (it swallows the `--`), so we show the direct form.
const CMD = 'npx tsx --env-file=.env scripts/heal-eans.ts';

/** Load every orphan mapping (products with ean IS NULL), paged. */
async function loadOrphans(limit: number | null): Promise<Orphan[]> {
  const orphans: Orphan[] = [];
  const pageSize = 1000;
  let offset = 0;
  for (;;) {
    const { data, error } = await db
      .from('products')
      .select('id, name, brand, mappings:supermarket_products ( id, supermarket_id, external_url )')
      .is('ean', null)
      .order('created_at', { ascending: false })
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;

    for (const p of data) {
      const mappings = (p.mappings ?? []) as Array<{
        id: string;
        supermarket_id: string;
        external_url: string;
      }>;
      for (const m of mappings) {
        orphans.push({
          supermarketProductId: m.id,
          supermarketId: m.supermarket_id,
          url: m.external_url,
          productName: (p.name as string) ?? '',
          brand: (p.brand as string) ?? null,
        });
      }
    }
    if (data.length < pageSize) break;
    offset += pageSize;
  }
  return limit ? orphans.slice(0, limit) : orphans;
}

/** Minimal CSV escaping. */
function csvCell(value: string | number): string {
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const CSV_HEADER =
  'supermarket_product_id,supermarket,product_name,url,suggested_ean,score,confidence,confirm_ean';

const CONFIDENCE_RANK: Record<MatchConfidence, number> = { low: 0, medium: 1, high: 2 };

/** Parse the apply CSV back into rows keyed by our header. */
function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const header = lines.shift();
  if (!header) return [];
  const cols = header.split(',').map((c) => c.trim());
  return lines.map((line) => {
    // Simple split; our own cells only quote when needed. Handle quoted commas.
    const cells: string[] = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') inQuotes = false;
        else cur += ch;
      } else if (ch === '"') inQuotes = true;
      else if (ch === ',') { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    const row: Record<string, string> = {};
    cols.forEach((c, i) => { row[c] = (cells[i] ?? '').trim(); });
    return row;
  });
}

async function apply(pairs: Array<{ smpId: string; ean: string }>): Promise<void> {
  let bound = 0;
  let merged = 0;
  let removed = 0;
  for (const { smpId, ean } of pairs) {
    try {
      const r = await bindMappingToEan(smpId, ean);
      bound++;
      if (r.merged) merged++;
      if (r.removedOrphanMaster) removed++;
      console.log(`✓ ${smpId} → ${ean}  (merged=${r.merged}, removedOrphan=${r.removedOrphanMaster})`);
    } catch (err) {
      console.error(`✗ ${smpId} → ${ean}: ${(err as Error).message}`);
    }
  }
  console.log(`\nDone. Bound ${bound}, merged ${merged}, removed ${removed} orphan master(s).`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const applyArg = args.find((a) => a.startsWith('--apply='));
  const outArg = args.find((a) => a.startsWith('--out='));
  const limitArg = args.find((a) => a.startsWith('--limit='));
  const minScoreArg = args.find((a) => a.startsWith('--min-score='));
  const autoConfArg = args.find((a) => a.startsWith('--auto-confidence='));
  const judgeThreshArg = args.find((a) => a.startsWith('--judge-threshold='));
  const auto = args.includes('--auto');
  const judge = args.includes('--judge');
  const useSuggested = args.includes('--use-suggested');

  const outPath = outArg?.split('=')[1] || 'heal-eans.csv';
  const limit = limitArg ? parseInt(limitArg.split('=')[1] ?? '', 10) || null : null;
  // Auto-bind threshold: score-based (--min-score) OR confidence-based
  // (--auto-confidence, default 'high'). --min-score wins if given.
  const minScore = minScoreArg ? parseFloat(minScoreArg.split('=')[1] ?? '') || 0 : null;
  const autoConfidence = (autoConfArg?.split('=')[1] as MatchConfidence) || 'high';
  // Min LLM confidence to accept a judged match (only relevant with --judge).
  const judgeThreshold = judgeThreshArg ? parseFloat(judgeThreshArg.split('=')[1] ?? '') || 0.7 : 0.7;

  // ---- APPLY MODE (from a curated CSV) ------------------------------------
  if (applyArg) {
    const path = applyArg.split('=')[1];
    if (!path) { console.error('Usage: --apply=heal-eans.csv'); process.exit(1); }
    const rows = parseCsv(readFileSync(path, 'utf8'));
    const pairs: Array<{ smpId: string; ean: string }> = [];
    for (const row of rows) {
      const smpId = row.supermarket_product_id ?? '';
      const raw = row.confirm_ean || (useSuggested ? row.suggested_ean : '') || '';
      const ean = raw.replace(/\D/g, '');
      if (smpId && /^\d{8,14}$/.test(ean)) pairs.push({ smpId, ean });
    }
    console.log(`Applying ${pairs.length} binding(s) from ${path}${useSuggested ? ' (confirm_ean, falling back to suggested_ean)' : ''}…\n`);
    await apply(pairs);
    return;
  }

  // ---- REPORT / AUTO / JUDGE MODE ------------------------------------------
  const index = await buildEanIndex();
  const orphans = await loadOrphans(limit);
  console.log(`Found ${orphans.length} EAN-less mapping(s) (matching against ${index.size} known EANs).\n`);
  if (orphans.length === 0) return;

  // Top-3 suggestions per orphan (top-1 is the headline match). Falls back to
  // the URL slug when the name is a placeholder ("Unknown product").
  const scored = orphans.map((o) => {
    const suggestions = suggestEansFromIndex(index, { name: o.productName, brand: o.brand, url: o.url }, 3);
    return { orphan: o, suggestions, match: suggestions[0] ?? NO_MATCH };
  });

  // Optional LLM judge over the ambiguous band (not-high, but has candidates).
  const verdicts = new Map<string, JudgeVerdict>();
  if (judge) {
    const toJudge = scored.filter((s) => s.match.confidence !== 'high' && s.suggestions.length > 0);
    console.log(`LLM judge (${revistaConfig.judgeModel}): adjudicating ${toJudge.length} ambiguous mapping(s)…`);
    const items: JudgeItem[] = toJudge.map((s) => ({
      id: s.orphan.supermarketProductId,
      name: s.orphan.productName,
      url: s.orphan.url,
      supermarket: s.orphan.supermarketId,
      candidates: s.suggestions,
    }));
    const res = await judgeEanMatches(items, {
      onProgress: (d, t) => process.stdout.write(`\r  judged ${d}/${t}`),
    });
    process.stdout.write('\n\n');
    for (const [k, v] of res) verdicts.set(k, v);
  }

  // Final EAN + a source label per orphan. HIGH token matches are trusted as-is;
  // the LLM verdict decides the rest when --judge is on.
  function resolve(s: (typeof scored)[number]): { ean: string; label: string } {
    if (s.match.confidence === 'high') return { ean: s.match.ean, label: 'high' };
    if (judge) {
      const v = verdicts.get(s.orphan.supermarketProductId);
      if (v?.ean && v.confidence >= judgeThreshold) return { ean: v.ean, label: `llm:${v.confidence.toFixed(2)}` };
      if (v?.ean) return { ean: '', label: `llm?:${v.confidence.toFixed(2)}` }; // judged but below threshold
      if (v) return { ean: '', label: 'llm-none' };
    }
    return { ean: '', label: s.match.confidence };
  }

  // Does an orphan clear the (non-judge) auto-bind bar?
  const qualifies = (m: Suggestion): boolean =>
    m.ean !== '' &&
    (minScore !== null
      ? m.score >= minScore
      : CONFIDENCE_RANK[m.confidence] >= CONFIDENCE_RANK[autoConfidence]);

  if (auto) {
    const pairs = scored
      .map((s) => {
        const ean = judge ? resolve(s).ean : qualifies(s.match) ? s.match.ean : '';
        return { smpId: s.orphan.supermarketProductId, ean };
      })
      .filter((p) => /^\d{8,14}$/.test(p.ean));
    const bar = judge
      ? `high + LLM-confirmed (>= ${judgeThreshold})`
      : minScore !== null
        ? `score >= ${minScore}`
        : `confidence >= ${autoConfidence}`;
    console.log(`--auto: binding ${pairs.length}/${orphans.length} (${bar}). Skipping the rest.\n`);
    await apply(pairs);
    const skipped = orphans.length - pairs.length;
    if (skipped > 0) console.log(`\n${skipped} unresolved mapping(s) skipped — review them in a CSV (${CMD}${judge ? ' --judge' : ''}).`);
    return;
  }

  // Write review CSV + print a preview table.
  const lines = [CSV_HEADER];
  for (const s of scored) {
    const r = resolve(s);
    lines.push([
      csvCell(s.orphan.supermarketProductId),
      csvCell(s.orphan.supermarketId),
      csvCell(s.orphan.productName),
      csvCell(s.orphan.url),
      csvCell(s.match.ean),
      csvCell(s.match.score.toFixed(2)),
      csvCell(r.label),
      csvCell(r.ean), // pre-filled confirm_ean (high + LLM-confirmed)
    ].join(','));
  }
  writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');

  const prefilled = scored.filter((s) => resolve(s).ean !== '').length;
  const byConf = { high: 0, medium: 0, low: 0 };
  for (const { match } of scored) byConf[match.confidence]++;

  for (const s of scored.slice(0, 40)) {
    const r = resolve(s);
    const flag = r.ean ? '✓' : s.match.confidence === 'medium' ? '~' : '?';
    console.log(
      `${flag} [${s.orphan.supermarketId.padEnd(14)}] ${s.orphan.productName.slice(0, 38).padEnd(38)} → ${r.ean || s.match.ean || '(none)'} (${r.label}) ${s.match.description.slice(0, 30)}`,
    );
  }
  if (scored.length > 40) console.log(`… and ${scored.length - 40} more.`);
  console.log(`\nToken confidence: ${byConf.high} high, ${byConf.medium} medium, ${byConf.low} low.`);
  console.log(`Pre-filled confirm_ean on ${prefilled}/${scored.length} rows${judge ? ' (high + LLM-confirmed)' : ' (high only)'}.`);
  console.log(`Wrote review CSV → ${outPath}`);
  if (!judge) console.log('Tip: add --judge to let the LLM adjudicate the medium/low cases.');
  console.log(`Review, then apply:  ${CMD} --apply=${outPath}`);
  console.log(`Or bind directly:    ${CMD} ${judge ? '--judge --auto' : '--auto'}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
