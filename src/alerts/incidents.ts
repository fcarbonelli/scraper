/**
 * Incidents: alerts deduplicated by `fingerprint` (migration 038).
 *
 * Telegram fires on state changes only:
 *   - a new incident opens                → normal message (with action buttons)
 *   - an open incident escalates severity → normal message
 *   - the condition is seen again         → DB update only (occurrences, evidence)
 *   - the condition clears                → auto-resolve + silent "✅" note
 *
 * Acknowledging an incident (Telegram button / PATCH /v1/alerts/:id) keeps it
 * live, so it stays quiet until it resolves.
 */

import { db } from '../shared/db.js';
import { logger } from '../shared/logger.js';
import { createAlert, notifyForAlert, type CreateAlertArgs } from './createAlert.js';
import { notifyResolved, type Severity } from './notify.js';

const LIVE_STATUSES = ['open', 'acknowledged'] as const;

const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };

interface LiveIncident {
  id: string;
  severity: Severity;
  title: string;
  occurrences: number;
  created_at: string;
}

export interface RaiseIncidentArgs extends CreateAlertArgs {
  fingerprint: string;
}

export interface RaisedIncident {
  id: string;
  /** 'opened' = new row; 'escalated' = severity went up; 'seen' = repeat. */
  outcome: 'opened' | 'escalated' | 'seen';
  notified: boolean;
}

async function findLive(fingerprint: string): Promise<LiveIncident | null> {
  const { data, error } = await db
    .from('alerts')
    .select('id, severity, title, occurrences, created_at')
    .eq('fingerprint', fingerprint)
    .in('status', [...LIVE_STATUSES])
    .maybeSingle();
  if (error) throw error;
  return (data as LiveIncident | null) ?? null;
}

/** Open a new incident, or refresh the live one for this fingerprint. */
export async function raiseIncident(args: RaiseIncidentArgs): Promise<RaisedIncident> {
  const existing = await findLive(args.fingerprint);
  if (!existing) {
    try {
      const created = await createAlert(args);
      return { id: created.id, outcome: 'opened', notified: created.notified };
    } catch (err) {
      // Lost a race against the partial unique index: treat as a repeat.
      if ((err as { code?: string }).code !== '23505') throw err;
      const raced = await findLive(args.fingerprint);
      if (!raced) throw err;
      return touch(raced, args);
    }
  }
  return touch(existing, args);
}

async function touch(existing: LiveIncident, args: RaiseIncidentArgs): Promise<RaisedIncident> {
  const escalated = SEVERITY_RANK[args.severity] > SEVERITY_RANK[existing.severity];
  const { error } = await db
    .from('alerts')
    .update({
      // Never downgrade a live incident: a down chain that recovers partially
      // is still the same incident until it resolves.
      severity: escalated ? args.severity : existing.severity,
      type: args.type,
      title: args.title,
      message: args.message,
      context: args.context ?? {},
      evidence: args.evidence ?? {},
      occurrences: existing.occurrences + 1,
      last_seen_at: new Date().toISOString(),
    })
    .eq('id', existing.id);
  if (error) throw error;

  const notified = escalated && !args.silent ? await notifyForAlert(existing.id, args) : false;
  logger.info(
    { alertId: existing.id, fingerprint: args.fingerprint, escalated, notified },
    escalated ? 'incident escalated' : 'incident seen again (no notification)',
  );
  return { id: existing.id, outcome: escalated ? 'escalated' : 'seen', notified };
}

/**
 * Resolve the live incident for this fingerprint, if any, and post a silent
 * Telegram note. Returns whether something was resolved.
 */
export async function resolveIncident(fingerprint: string, note: string): Promise<boolean> {
  const existing = await findLive(fingerprint);
  if (!existing) return false;

  const { error } = await db
    .from('alerts')
    .update({ status: 'resolved', resolved_at: new Date().toISOString() })
    .eq('id', existing.id);
  if (error) throw error;

  const days = Math.max(
    1,
    Math.round((Date.now() - new Date(existing.created_at).getTime()) / 86_400_000),
  );
  await notifyResolved(
    `Resuelto: ${existing.title}`,
    `${note} (estuvo abierto ${days === 1 ? '1 día' : `${days} días`}, ${existing.occurrences} detección(es)).`,
  );
  logger.info({ alertId: existing.id, fingerprint }, 'incident auto-resolved');
  return true;
}
