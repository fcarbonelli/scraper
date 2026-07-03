/**
 * EAN suggestion engine (for healing EAN-less products).
 *
 * Given an orphan product's scraped name + brand, rank the catalog EANs it most
 * likely belongs to. Used by BOTH the heal CLI (scripts/heal-eans.ts) and the
 * frontend worklist (GET /v1/products/missing-ean) so suggestions are identical
 * everywhere.
 *
 * SIGNAL: we score the orphan name against, per EAN, the union of
 *   - the catalog taxonomy text (descriptionForms + brand + variety + format), and
 *   - the scraped NAMES of sibling products that already carry that EAN.
 * Sibling scraped-names are the strongest signal — the same product at another
 * chain is usually named almost identically to the orphan.
 *
 * Dependency-free (token overlap). If this proves too weak we can swap in the
 * embeddings/LLM matcher from src/revistas/match.ts behind the same interface.
 */

import { db } from '../shared/db.js';
import { getCatalogEans } from '../shared/catalog.js';

export type MatchConfidence = 'high' | 'medium' | 'low';

export interface EanSuggestion {
  ean: string;
  /** 0..1 token-overlap of the orphan name against this EAN's known text. */
  score: number;
  confidence: MatchConfidence;
  /** Human-readable label (catalog descriptionForms) for display. */
  description: string;
}

/** Per-EAN bag of tokens (from catalog + sibling product names) + a label. */
interface EanIndexEntry {
  tokens: Set<string>;
  description: string;
}

const CACHE_TTL_MS = 5 * 60_000;
let cache: { index: Map<string, EanIndexEntry>; loadedAt: number } | null = null;

/** Strip accents, lowercase, split into alphanumeric tokens (len > 1). */
export function tokenize(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t.length > 1);
}

/** Names that carry no real product identity (failed/legacy ingests). */
export function isPlaceholderName(name: string | null | undefined): boolean {
  const n = (name ?? '').trim().toLowerCase();
  return n === '' || n === 'unknown product' || n === 'unknown' || n === 'producto';
}

/** URL path noise we never want as match tokens. */
const URL_STOPWORDS = new Set([
  'www', 'com', 'ar', 'html', 'htm', 'sucursal', 'moreno', 'art', 'shop',
  'mla', 'item', 'producto', 'productos', 'product',
]);

/**
 * Tokens extracted from a product URL's path — the slug usually encodes the
 * product (e.g. ".../lavandina-odex-comun-4-lt-26562.html"). Drops host/section
 * noise and long numeric ids (keeps short numbers like sizes: 700, 4).
 */
export function urlTokens(url: string): string[] {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    /* not a full URL — tokenize as-is */
  }
  return tokenize(path.replace(/_/g, ' ')).filter(
    (t) => !URL_STOPWORDS.has(t) && !/^\d{5,}$/.test(t),
  );
}

/**
 * Build (and cache) the per-EAN token index: catalog text for every catalog EAN,
 * plus the scraped names of any DB products that already carry each EAN.
 */
export async function buildEanIndex(): Promise<Map<string, EanIndexEntry>> {
  const now = Date.now();
  if (cache && now - cache.loadedAt < CACHE_TTL_MS) return cache.index;

  const index = new Map<string, EanIndexEntry>();

  // 1. Seed from the catalog (authoritative descriptions).
  const catalog = await getCatalogEans();
  for (const [ean, entry] of catalog) {
    const tokens = new Set(
      tokenize(`${entry.descriptionForms} ${entry.brand} ${entry.variety} ${entry.format}`),
    );
    index.set(ean, { tokens, description: entry.descriptionForms });
  }

  // 2. Add sibling scraped names (products that already carry an EAN), paged.
  const pageSize = 1000;
  let offset = 0;
  for (;;) {
    const { data, error } = await db
      .from('products')
      .select('ean, name, brand')
      .not('ean', 'is', null)
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;

    for (const row of data) {
      const ean = row.ean as string;
      const name = (row.name as string) ?? '';
      // Skip placeholder-named siblings ("Unknown product") — their tokens would
      // pollute the index and make every no-name orphan match them at 1.0.
      if (isPlaceholderName(name)) continue;
      const text = `${name} ${(row.brand as string) ?? ''}`;
      const entry = index.get(ean);
      if (entry) {
        for (const t of tokenize(text)) entry.tokens.add(t);
      } else {
        // EAN not in the catalog but present in the DB — still a valid target.
        index.set(ean, {
          tokens: new Set(tokenize(text)),
          description: name || ean,
        });
      }
    }
    if (data.length < pageSize) break;
    offset += pageSize;
  }

  cache = { index, loadedAt: now };
  return index;
}

/** Force a rebuild on next call (e.g. after bulk healing). */
export function invalidateEanIndex(): void {
  cache = null;
}

function confidenceFor(score: number, margin: number): MatchConfidence {
  if (score >= 0.7 && margin >= 0.15) return 'high';
  if (score >= 0.45) return 'medium';
  return 'low';
}

/** What we know about an orphan to match on. */
export interface MatchInput {
  name: string;
  brand?: string | null;
  /** A mapping URL — used as the signal when the name is a placeholder. */
  url?: string | null;
}

/**
 * Rank the most likely EANs for an orphan. Returns up to `topN` suggestions
 * sorted by score. `confidence` on the FIRST result also factors in the margin
 * over the runner-up (a clear winner is more trustworthy).
 *
 * When the name is a placeholder ("Unknown product"), we fall back to the URL
 * slug — which usually still encodes the product on slug-based sites.
 */
export function suggestEansFromIndex(
  index: Map<string, EanIndexEntry>,
  input: MatchInput,
  topN = 3,
): EanSuggestion[] {
  const orphanTokens = isPlaceholderName(input.name)
    ? (input.url ? urlTokens(input.url) : [])
    : tokenize(`${input.name} ${input.brand ?? ''}`);
  if (orphanTokens.length === 0) return [];

  const scored: Array<{ ean: string; score: number; description: string }> = [];
  for (const [ean, entry] of index) {
    let shared = 0;
    for (const t of orphanTokens) if (entry.tokens.has(t)) shared++;
    const score = shared / orphanTokens.length;
    if (score > 0) scored.push({ ean, score, description: entry.description });
  }
  scored.sort((a, b) => b.score - a.score);

  const top = scored.slice(0, topN);
  return top.map((s, i) => {
    const margin = i === 0 ? s.score - (scored[1]?.score ?? 0) : 0;
    return {
      ean: s.ean,
      score: Number(s.score.toFixed(3)),
      confidence: i === 0 ? confidenceFor(s.score, margin) : confidenceFor(s.score, 0),
      description: s.description,
    };
  });
}

/** Convenience: build the index (cached) and suggest in one call. */
export async function suggestEans(
  input: MatchInput,
  topN = 3,
): Promise<EanSuggestion[]> {
  const index = await buildEanIndex();
  return suggestEansFromIndex(index, input, topN);
}
