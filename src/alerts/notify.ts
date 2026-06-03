/**
 * Telegram notifier.
 *
 * Sends formatted alerts to a Telegram chat via the Bot API. Configuration
 * is read from env (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_MIN_SEVERITY).
 *
 * Behavior:
 *   - If the bot/chat aren't configured, this is a no-op (silently skipped).
 *   - Severities below TELEGRAM_MIN_SEVERITY are filtered out so info-level
 *     noise doesn't drown out real alerts.
 *
 * Usage:
 *   await notifyAlert({ severity: 'critical', title: 'SuperZ degraded', body: '...' });
 */

import { env } from '../shared/env.js';
import { logger } from '../shared/logger.js';
import {
  sendMessage,
  callbackData,
  type InlineKeyboard,
} from '../telegram/bot.js';

export type Severity = 'info' | 'warning' | 'critical';

const SEVERITY_RANK: Record<Severity, number> = {
  info: 0,
  warning: 1,
  critical: 2,
};

const SEVERITY_EMOJI: Record<Severity, string> = {
  info: '🔵',
  warning: '🟡',
  critical: '🔴',
};

export interface AlertPayload {
  severity: Severity;
  title: string;
  /** Free-form body. Plain text or basic HTML (Telegram subset). */
  body?: string;
  /** Optional URL the recipient can click to view full details. */
  url?: string;
  /** Optional structured context shown as key/value list. */
  context?: Record<string, string | number | boolean | null | undefined>;
  /** Optional inline action buttons for this alert. */
  actions?: AlertAction[];
}

export interface AlertAction {
  label: string;
  /** Callback data string sent back when the button is pressed. */
  data: string;
}

/**
 * Build standard action buttons for a supermarket-level alert.
 *
 * Telegram limits callback_data to 64 bytes, so we pass only the alert_id
 * in the callback and look up the run_id + supermarket_id from the alert's
 * context column when the button is pressed.
 */
export function buildSupermarketAlertActions(alertId: string): AlertAction[] {
  // Use short prefix + alertId (UUIDs are 36 chars, prefix+colon = ~40 total)
  return [
    { label: '🔄 Retry failed', data: callbackData('retry', alertId) },
    { label: '📋 Fill yesterday', data: callbackData('fill', alertId) },
    { label: '✓ Acknowledge', data: callbackData('ack', alertId) },
  ];
}

/**
 * Send an alert to Telegram. Safe to call even when not configured.
 * Returns whether a message was actually sent.
 */
export async function notifyAlert(payload: AlertPayload): Promise<boolean> {
  if (!isConfigured()) {
    logger.debug({ title: payload.title }, 'Telegram not configured, skipping notify');
    return false;
  }

  if (SEVERITY_RANK[payload.severity] < SEVERITY_RANK[env.TELEGRAM_MIN_SEVERITY]) {
    logger.debug(
      { severity: payload.severity, threshold: env.TELEGRAM_MIN_SEVERITY },
      'severity below Telegram threshold, skipping',
    );
    return false;
  }

  const text = formatMessage(payload);
  const keyboard = buildKeyboard(payload.actions);

  const messageId = await sendMessage(text, keyboard);
  return messageId !== null;
}

function isConfigured(): boolean {
  return Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
}

/**
 * Build the HTML-formatted message body. Keep it short and scannable —
 * the dashboard has the full detail.
 */
function formatMessage(p: AlertPayload): string {
  const lines: string[] = [];
  const emoji = SEVERITY_EMOJI[p.severity];
  lines.push(`${emoji} <b>${escapeHtml(p.severity.toUpperCase())}: ${escapeHtml(p.title)}</b>`);

  if (p.body) {
    lines.push('');
    lines.push(escapeHtml(p.body));
  }

  if (p.context && Object.keys(p.context).length > 0) {
    lines.push('');
    for (const [key, value] of Object.entries(p.context)) {
      if (value === null || value === undefined) continue;
      lines.push(`<b>${escapeHtml(key)}:</b> ${escapeHtml(String(value))}`);
    }
  }

  if (p.url) {
    lines.push('');
    lines.push(`<a href="${escapeHtml(p.url)}">View details</a>`);
  }

  return lines.join('\n');
}

/** Convert AlertActions into the inline keyboard format Telegram expects. */
function buildKeyboard(actions?: AlertAction[]): InlineKeyboard | undefined {
  if (!actions || actions.length === 0) return undefined;
  // One button per row for readability on mobile
  return actions.map((a) => [{ text: a.label, callback_data: a.data }]);
}

/** Escape user-controlled strings for safe HTML insertion (Telegram subset). */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
