/**
 * Health probes for the revista check, so it can never fail silently again.
 *
 * Two failure modes were measured in production on 2026-07-30 and both were
 * invisible for days:
 *
 *   A. `runRevistaCheck` early-returns without writing ANYTHING when
 *      `REVISTA_ENABLED=false`, `OPENAI_API_KEY` is empty, or no chain is
 *      configured. No check-log row, no magazine, no alert — indistinguishable
 *      from "nothing new today". It ran like that from 29/07 and nobody knew.
 *   B. The process is killed mid-processing, leaving the magazine pinned at
 *      `status='processing'`. A thrown error would have marked it `failed`, so
 *      these rows mean the process died. Six were sitting there, the oldest a
 *      month old, and nothing ever said so. Worse, a stuck row is never
 *      superseded and never supersedes, so it also poisons "which issue is
 *      current".
 *
 * Both alerts fire only on a STATE CHANGE. Turning the pipeline off can be a
 * deliberate, long-lived decision; an alert every single day would be noise,
 * and replacing a silence problem with a noise problem fixes nothing.
 */

import { db } from '../shared/db.js';
import { logger } from '../shared/logger.js';
import { createAlert, type AlertType } from '../alerts/createAlert.js';
import { revistaConfig } from './config.js';
import { loadRevistaSupermarkets } from './pipeline.js';

/** A magazine still 'processing' after this long was almost certainly killed. */
const STUCK_AFTER_HOURS = 6;

/** True when an unresolved alert of this type already exists — don't re-fire. */
async function alreadyOpen(type: AlertType): Promise<boolean> {
  const { data, error } = await db
    .from('alerts')
    .select('id')
    .eq('type', type)
    .eq('status', 'open')
    .limit(1);
  if (error) {
    logger.warn({ err: error, type }, 'revista health: could not check open alerts');
    return false;
  }
  return (data?.length ?? 0) > 0;
}

/**
 * Warn when the daily check would return without doing — or recording —
 * anything. Returns true when the pipeline is healthy enough to run.
 */
export async function checkRevistaConfigHealth(): Promise<boolean> {
  const reasons: string[] = [];
  if (!revistaConfig.enabled) reasons.push('REVISTA_ENABLED=false');
  if (!revistaConfig.openaiApiKey) reasons.push('falta OPENAI_API_KEY');

  let chains = 0;
  try {
    chains = (await loadRevistaSupermarkets()).length;
    if (chains === 0) reasons.push('no hay cadenas con config.source_type="revista" activas');
  } catch (err) {
    logger.warn({ err }, 'revista health: could not load chains');
  }

  if (reasons.length === 0) return true;

  if (await alreadyOpen('revista_disabled')) {
    logger.warn({ reasons }, 'revista check disabled (alert already open)');
    return false;
  }

  await createAlert({
    severity: 'warning',
    type: 'revista_disabled',
    title: 'El chequeo de revistas no va a correr',
    message:
      `El chequeo diario de revistas sale sin procesar nada y sin dejar rastro: ${reasons.join('; ')}. ` +
      'Ningún folleto nuevo va a entrar hasta que se corrija.',
    context: { reasons, chains_configured: chains },
  });
  return false;
}

/**
 * Warn about magazines pinned in `processing` — the signature of a killed run.
 */
export async function checkStuckMagazines(): Promise<number> {
  const cutoff = new Date(Date.now() - STUCK_AFTER_HOURS * 3_600_000).toISOString();
  const { data, error } = await db
    .from('revista_magazines')
    .select('id, supermarket_id, label, detected_at')
    .eq('status', 'processing')
    .lt('detected_at', cutoff)
    .order('detected_at', { ascending: true });
  if (error) {
    logger.warn({ err: error }, 'revista health: could not query stuck magazines');
    return 0;
  }

  const stuck = data ?? [];
  if (stuck.length === 0) return 0;

  if (await alreadyOpen('revista_stuck')) {
    logger.warn({ stuck: stuck.length }, 'revista magazines stuck (alert already open)');
    return stuck.length;
  }

  const oldest = stuck[0];
  await createAlert({
    severity: 'warning',
    type: 'revista_stuck',
    title: `${stuck.length} revista(s) trabadas procesando`,
    message:
      `Hay ${stuck.length} revista(s) en status='processing' hace más de ${STUCK_AFTER_HOURS}h — ` +
      `el proceso se murió a mitad del escaneo. La más vieja es "${oldest?.label}" ` +
      `(${oldest?.supermarket_id}, detectada ${oldest?.detected_at}). ` +
      'Mientras sigan así no supersedean ni son supersedeadas, así que también ensucian qué edición está vigente.',
    context: {
      count: stuck.length,
      magazines: stuck.map((m) => ({ id: m.id, supermarket_id: m.supermarket_id, label: m.label })),
    },
  });
  return stuck.length;
}
