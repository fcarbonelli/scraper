/**
 * Revista pipeline configuration, derived from validated env (src/shared/env.ts).
 *
 * Kept tiny and side-effect-free so it can be imported anywhere. The OpenAI key
 * is NOT asserted here — callers that actually hit the API assert it via
 * {@link assertOpenAiKey} so the rest of the app (and smoke tests) load fine
 * without it.
 */

import { env } from '../shared/env.js';

export const revistaConfig = {
  openaiApiKey: env.OPENAI_API_KEY,
  visionModel: env.REVISTA_VISION_MODEL,
  judgeModel: env.REVISTA_JUDGE_MODEL,
  embeddingModel: env.REVISTA_EMBEDDING_MODEL,
  matchThreshold: env.REVISTA_MATCH_THRESHOLD,
  concurrency: env.REVISTA_CONCURRENCY,
  storageBucket: env.REVISTA_STORAGE_BUCKET,
  enabled: env.REVISTA_ENABLED,
  /** Max time for ONE site's discovery probe before we give up (prevents a hung
   *  Playwright/network call from blocking the rest of the daily check). */
  discoverTimeoutMs: 90_000,
  /** Hard ceiling for the whole daily magazine check (all sites) — belt-and-
   *  suspenders so a wedge can never stall the orchestrator indefinitely. */
  checkTimeoutMs: 20 * 60_000,
} as const;

/** Throw a clear error if the OpenAI key is missing right before we need it. */
export function assertOpenAiKey(): string {
  if (!revistaConfig.openaiApiKey) {
    throw new Error(
      'OPENAI_API_KEY is not set. The revista pipeline needs it for vision + matching.',
    );
  }
  return revistaConfig.openaiApiKey;
}
