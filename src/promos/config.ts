/**
 * Promotions module configuration, derived from validated env (src/shared/env.ts).
 *
 * Side-effect-free so it can be imported anywhere (including smoke tests). The
 * pipeline early-returns when `enabled` is false.
 */

import { env } from '../shared/env.js';

export const promosConfig = {
  /** Master switch for the weekly orchestrator hook. */
  enabled: env.PROMOS_ENABLED,
  /** Weekly cron expression (evaluated in env.TZ). */
  cron: env.PROMOS_CRON,
  /** Hard ceiling for one full promos run (all providers) — belt-and-suspenders
   *  so a wedged network call can never stall the orchestrator indefinitely. */
  runTimeoutMs: 10 * 60_000,
  /** Politeness delay between paged requests to a provider (ms). */
  requestDelayMs: 250,
} as const;
