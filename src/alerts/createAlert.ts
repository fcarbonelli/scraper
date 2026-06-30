/**
 * Alert creation: writes to the `alerts` DB table and fires Telegram if
 * the severity warrants it.
 *
 * This is the single entry point for creating an alert. Callers (aggregator,
 * worker, future health checks) should always go through here so:
 *   - alerts always land in the DB (visible to dashboard/API)
 *   - notification side-effects are uniform
 *   - severity threshold for Telegram is honored automatically
 */

import { db } from '../shared/db.js';
import { logger } from '../shared/logger.js';
import { notifyAlert, buildSupermarketAlertActions, type Severity } from './notify.js';

export type AlertType =
  | 'supermarket_degraded'
  | 'supermarket_unstable'
  | 'selector_broken'
  | 'rate_limited'
  | 'auth_required'
  | 'product_not_found'
  | 'price_missing'
  | 'price_anomaly'
  | 'stock_change'
  | 'revista_review';

export interface CreateAlertArgs {
  severity: Severity;
  type: AlertType;
  title: string;
  message: string;
  /** Optional; null when the alert spans the whole supermarket or is generic. */
  supermarketId?: string | null;
  /** Optional; only set for product-specific alerts. */
  productId?: string | null;
  /** Free-form details kept in the DB row's `context` jsonb. */
  context?: Record<string, unknown>;
  /** Optional click-through URL added to the Telegram message. */
  url?: string;
  /** If true, skips Telegram even if severity passes the threshold. */
  silent?: boolean;
}

export interface CreatedAlert {
  id: string;
  notified: boolean;
}

export async function createAlert(args: CreateAlertArgs): Promise<CreatedAlert> {
  const { data, error } = await db
    .from('alerts')
    .insert({
      severity: args.severity,
      type: args.type,
      title: args.title,
      message: args.message,
      supermarket_id: args.supermarketId ?? null,
      product_id: args.productId ?? null,
      context: args.context ?? {},
      status: 'open',
    })
    .select('id')
    .single();

  if (error) throw error;
  const alertId = data.id as string;

  let notified = false;
  if (!args.silent) {
    const notifyArgs: Parameters<typeof notifyAlert>[0] = {
      severity: args.severity,
      title: args.title,
      body: args.message,
      context: buildNotifyContext(args),
    };
    if (args.url !== undefined) notifyArgs.url = args.url;

    // Attach action buttons when we have enough context.
    // The alert's context column stores run_id + supermarket — the callback
    // handler looks those up by alert_id when a button is pressed.
    const runId = args.context?.run_id;
    if (args.supermarketId && typeof runId === 'string') {
      notifyArgs.actions = buildSupermarketAlertActions(alertId);
    }

    notified = await notifyAlert(notifyArgs);
  }

  logger.info(
    {
      alertId,
      severity: args.severity,
      type: args.type,
      supermarketId: args.supermarketId,
      notified,
    },
    'alert created',
  );

  return { id: alertId, notified };
}

/**
 * Pull a few helpful fields out of the alert into the Telegram context block.
 * Only string/number/boolean values — keeps the message readable.
 */
function buildNotifyContext(
  args: CreateAlertArgs,
): Record<string, string | number | boolean> | undefined {
  const out: Record<string, string | number | boolean> = {};
  if (args.supermarketId) out.supermarket = args.supermarketId;
  if (args.context) {
    for (const [k, v] of Object.entries(args.context)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        out[k] = v;
      }
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
