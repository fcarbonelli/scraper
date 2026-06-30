/**
 * Matching: EAN exact → embedding retrieval (top-K) → deterministic brand
 * filter → LLM judge. Two-stage + a hard filter to kill cross-brand false
 * positives before they reach the judge.
 */

import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { revistaConfig, assertOpenAiKey } from './config.js';
import { withRetry } from './retry.js';
import { mapPool } from './pool.js';
import type { CatalogProduct } from './catalog.js';
import type { ExtractedProduct } from './extract.js';

let client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!client) client = new OpenAI({ apiKey: assertOpenAiKey() });
  return client;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------
function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function normalizeText(s: string): string {
  let t = stripAccents(s.toLowerCase());
  t = t
    .replace(/(\d+)\s*(lt|lts|litros?)\b/g, '$1l')
    .replace(/(\d+)\s*(cc|ml|mililitros?)\b/g, '$1ml')
    .replace(/(\d+)\s*(kg|kilos?|kilogramos?)\b/g, '$1kg')
    .replace(/(\d+)\s*(gr|grs|gramos?)\b/g, '$1g')
    .replace(/\bx\s*(\d+)/g, 'x$1');
  return t.replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function productText(p: CatalogProduct): string {
  return normalizeText([p.brand, p.name, p.quantity].filter(Boolean).join(' '));
}

function itemText(item: ExtractedProduct): string {
  return normalizeText([item.brand, item.name, item.quantity].filter(Boolean).join(' '));
}

/** Same brand? Whole-word match of the item brand inside (brand + name) of the candidate. */
function brandMatches(itemBrand: string, c: CatalogProduct): boolean {
  const needle = normalizeText(itemBrand).split(' ').filter(Boolean);
  if (needle.length === 0) return true;
  const hay = normalizeText(`${c.brand ?? ''} ${c.name}`).split(' ');
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (needle.every((w, j) => hay[i + j] === w)) return true;
  }
  return false;
}

/** Content words (no numbers/units, length >= 3) for overlap checks. */
function contentTokens(s: string): Set<string> {
  return new Set(normalizeText(s).split(' ').filter((w) => w.length >= 3 && !/\d/.test(w)));
}

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------
function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await withRetry(
    () => getClient().embeddings.create({ model: revistaConfig.embeddingModel, input: texts }),
    { label: 'embeddings' },
  );
  return res.data.map((d) => d.embedding);
}

async function embedAll(texts: string[], chunk = 256): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += chunk) {
    out.push(...(await embedBatch(texts.slice(i, i + chunk))));
  }
  return out;
}

interface IndexedProduct {
  product: CatalogProduct;
  embedding: number[];
}

export interface CatalogIndex {
  indexed: IndexedProduct[];
  byEan: Map<string, CatalogProduct>;
}

/** Build the in-memory catalog index (embeddings + EAN map). */
export async function buildCatalogIndex(products: CatalogProduct[]): Promise<CatalogIndex> {
  const embeddings = await embedAll(products.map(productText));
  const indexed: IndexedProduct[] = products.map((product, i) => ({
    product,
    embedding: embeddings[i] ?? [],
  }));
  const byEan = new Map<string, CatalogProduct>();
  for (const p of products) if (p.ean) byEan.set(p.ean.replace(/\D/g, ''), p);
  return { indexed, byEan };
}

// ---------------------------------------------------------------------------
// Judge
// ---------------------------------------------------------------------------
const Judgement = z.object({
  best_candidate_id: z
    .string()
    .nullable()
    .describe('id of the MOST likely same-product candidate, or null if none relate'),
  confidence: z.number().describe('0 to 1: confidence best_candidate_id is the same product'),
  reason: z.string().describe('Short justification in Spanish'),
});

const JUDGE_SYSTEM = `Sos un verificador de coincidencias de productos de limpieza/supermercado.
Te doy un producto leído de una revista y candidatos del catálogo que YA son de la misma marca.
Tu tarea: decidir si alguno es el MISMO producto, o si ninguno lo es.

Reglas:
- Devolvé best_candidate_id sólo si es el MISMO producto: misma línea/variante/tipo
  (ej. "lavandina en gel original" = "lavandina en gel original").
- Una diferencia de tamaño/presentación (510ml vs 500ml, 1L vs 900ml) NO descarta el match:
  sólo baja un poco la confianza. El tamaño es lo ÚNICO en lo que sos flexible.
- Si es un TIPO de producto distinto aunque sea la misma marca
  (ej. "CIF Lustramuebles" vs "CIF Limpiador Baño"), devolvé best_candidate_id = null.
- Si ninguno es el mismo producto, devolvé null. Es esperable y correcto:
  la mayoría de los productos de la revista NO están en este catálogo.
- confidence: 0.9+ casi idéntico; 0.6-0.8 mismo producto con dudas de tamaño/formato; <0.3 distinto.`;

export interface MatchResult {
  item: ExtractedProduct;
  page: number;
  method: 'ean' | 'llm' | 'none';
  matched: CatalogProduct | null;
  confidence: number;
  reason: string;
  candidates: CatalogProduct[];
}

export async function matchItem(
  item: ExtractedProduct,
  page: number,
  index: CatalogIndex,
  queryEmb?: number[],
  topK = 8,
): Promise<MatchResult> {
  // 1) Exact EAN (free).
  if (item.ean) {
    const hit = index.byEan.get(item.ean.replace(/\D/g, ''));
    if (hit) {
      return { item, page, method: 'ean', matched: hit, confidence: 1, reason: 'EAN idéntico', candidates: [hit] };
    }
  }

  // 2) Embedding retrieval → top-K.
  const emb = queryEmb ?? (await embedBatch([itemText(item)]))[0] ?? [];
  const scored = index.indexed
    .map((ip) => ({ p: ip.product, score: cosine(emb, ip.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
  let candidates = scored.map((s) => s.p);

  // 2b) Deterministic brand filter — brand is the discriminator.
  if (item.brand && normalizeText(item.brand)) {
    const sameBrand = candidates.filter((c) => brandMatches(item.brand as string, c));
    if (sameBrand.length === 0) {
      return {
        item, page, method: 'none', matched: null, confidence: 0,
        reason: `Sin candidatos de la marca "${item.brand}" en el catálogo`, candidates,
      };
    }
    candidates = sameBrand;
  }

  // 3) LLM judge.
  const candidateList = candidates
    .map((c) => `- id=${c.id} | marca=${c.brand ?? '?'} | ${c.name} | cant=${c.quantity ?? '?'} | ean=${c.ean ?? '?'}`)
    .join('\n');

  const completion = await withRetry(
    () =>
      getClient().chat.completions.parse({
        model: revistaConfig.judgeModel,
        messages: [
          { role: 'system', content: JUDGE_SYSTEM },
          {
            role: 'user',
            content: `PRODUCTO DE LA REVISTA:
marca=${item.brand ?? '?'} | ${item.name} | cant=${item.quantity ?? '?'} | ean=${item.ean ?? '?'}

CANDIDATOS DEL CATÁLOGO:
${candidateList || '(sin candidatos)'}`,
          },
        ],
        response_format: zodResponseFormat(Judgement, 'judgement'),
      }),
    { label: `judge p${page}` },
  );

  const j = completion.choices[0]?.message.parsed;
  const best = j?.best_candidate_id
    ? candidates.find((c) => c.id === j.best_candidate_id) ?? null
    : null;
  const confidence = j?.confidence ?? 0;

  if (best && confidence >= revistaConfig.matchThreshold) {
    // Guard for items with no readable brand: require content-word overlap.
    const hasBrand = !!(item.brand && normalizeText(item.brand));
    if (!hasBrand) {
      const itemTok = contentTokens(item.name);
      const candTok = contentTokens(`${best.brand ?? ''} ${best.name}`);
      const overlap = [...itemTok].some((t) => candTok.has(t));
      if (!overlap) {
        return {
          item, page, method: 'none', matched: null, confidence,
          reason: `Sin marca y sin palabras en común con "${best.name}" → descartado`, candidates,
        };
      }
    }
    return { item, page, method: 'llm', matched: best, confidence, reason: j?.reason ?? '', candidates };
  }

  return {
    item, page, method: 'none', matched: null,
    confidence, reason: j?.reason ?? 'Sin coincidencia suficiente', candidates,
  };
}

/** Match many items: pre-embed all queries in batches, then run with bounded concurrency. */
export async function matchItems(
  entries: { item: ExtractedProduct; page: number }[],
  index: CatalogIndex,
  concurrency = revistaConfig.concurrency,
): Promise<MatchResult[]> {
  if (entries.length === 0) return [];
  const embeddings = await embedAll(entries.map((e) => itemText(e.item)));
  return mapPool(entries, concurrency, (e, i) => matchItem(e.item, e.page, index, embeddings[i]));
}
