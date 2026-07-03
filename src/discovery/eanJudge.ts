/**
 * LLM judge for EAN healing.
 *
 * The token matcher (eanMatch.ts) proposes candidate EANs for each orphan. For
 * the ambiguous middle band (medium/low confidence) we ask an LLM to adjudicate:
 * given the orphan's name/URL and the top candidates, which EAN (if any) is the
 * SAME product — accounting for brand, variety and size/format.
 *
 * Reuses the OpenAI client + judge model already configured for the revista
 * pipeline (env REVISTA_JUDGE_MODEL, OPENAI_API_KEY). Batches several orphans per
 * request to keep cost/latency down.
 */

import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { revistaConfig, assertOpenAiKey } from '../revistas/config.js';
import { logger } from '../shared/logger.js';
import type { EanSuggestion } from './eanMatch.js';

let client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!client) client = new OpenAI({ apiKey: assertOpenAiKey() });
  return client;
}

/** One orphan to adjudicate, with the candidates the matcher proposed. */
export interface JudgeItem {
  id: string;
  name: string;
  url?: string | null;
  supermarket?: string | null;
  candidates: EanSuggestion[];
}

export interface JudgeVerdict {
  /** Chosen catalog EAN, or null if none of the candidates is the same product. */
  ean: string | null;
  /** Model confidence 0..1. */
  confidence: number;
  reason: string;
}

const Verdict = z.object({
  id: z.string(),
  best_ean: z.string(), // "" when none match
  confidence: z.number(),
  reason: z.string(),
});
const BatchResult = z.object({ verdicts: z.array(Verdict) });

const SYSTEM_PROMPT = `Sos un experto en productos de limpieza y del hogar del retail argentino.
Te doy productos "huérfanos" (sin EAN) y, para cada uno, una lista de CANDIDATOS del catálogo (cada uno con su EAN y descripción).
Decidí, para cada producto, cuál candidato es EXACTAMENTE el mismo producto.

Reglas:
- Debe coincidir la MARCA, la VARIEDAD/fragancia y el FORMATO/tamaño (ml, cc, lt, gr, unidades).
- Si el tamaño difiere (ej. 500 ml vs 900 ml) NO es el mismo producto: devolvé best_ean="".
- Si ningún candidato coincide con seguridad, devolvé best_ean="".
- Cuando el nombre del producto es vago (ej. "Unknown product"), usá la URL para inferir el producto.
- confidence: 0..1 (1 = certeza total).
Devolvé un veredicto por cada id recibido.`;

function renderItem(item: JudgeItem): string {
  const cands = item.candidates
    .map((c) => `    - ean=${c.ean} | ${c.description}`)
    .join('\n');
  return `id=${item.id}
  supermercado=${item.supermarket ?? '?'}
  nombre=${item.name || '(vacío)'}
  url=${item.url ?? '(sin url)'}
  candidatos:
${cands || '    (sin candidatos)'}`;
}

/** Adjudicate a single batch of items (one LLM call). */
async function judgeBatch(items: JudgeItem[]): Promise<Map<string, JudgeVerdict>> {
  const completion = await getClient().chat.completions.parse({
    model: revistaConfig.judgeModel,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `PRODUCTOS A EVALUAR:\n\n${items.map(renderItem).join('\n\n')}` },
    ],
    response_format: zodResponseFormat(BatchResult, 'ean_judgements'),
  });

  const parsed = completion.choices[0]?.message.parsed;
  const out = new Map<string, JudgeVerdict>();
  for (const v of parsed?.verdicts ?? []) {
    const ean = v.best_ean.replace(/\D/g, '');
    out.set(v.id, {
      ean: /^\d{8,14}$/.test(ean) ? ean : null,
      confidence: v.confidence,
      reason: v.reason,
    });
  }
  return out;
}

/**
 * Adjudicate every item, batched. Items with no candidates are returned as a
 * null verdict without hitting the API. `onProgress` fires per completed batch.
 */
export async function judgeEanMatches(
  items: JudgeItem[],
  opts: { batchSize?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<Map<string, JudgeVerdict>> {
  const batchSize = opts.batchSize ?? 12;
  const result = new Map<string, JudgeVerdict>();

  const judgeable = items.filter((i) => i.candidates.length > 0);
  for (const i of items) {
    if (i.candidates.length === 0) {
      result.set(i.id, { ean: null, confidence: 0, reason: 'sin candidatos' });
    }
  }

  let done = 0;
  for (let i = 0; i < judgeable.length; i += batchSize) {
    const batch = judgeable.slice(i, i + batchSize);
    try {
      const verdicts = await judgeBatch(batch);
      for (const item of batch) {
        result.set(item.id, verdicts.get(item.id) ?? { ean: null, confidence: 0, reason: 'sin veredicto' });
      }
    } catch (err) {
      logger.error({ err, batchStart: i }, 'ean judge batch failed');
      for (const item of batch) {
        result.set(item.id, { ean: null, confidence: 0, reason: `error: ${(err as Error).message}` });
      }
    }
    done += batch.length;
    opts.onProgress?.(done, judgeable.length);
  }

  return result;
}
