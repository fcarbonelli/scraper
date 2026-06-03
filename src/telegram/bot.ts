/**
 * Telegram Bot API helpers.
 *
 * Thin wrappers around the Telegram HTTP API for the features we use:
 *   - Inline keyboard buttons on messages
 *   - Answering callback queries (button presses)
 *   - Editing messages after an action completes
 *
 * No external library — the Bot API is simple enough that raw fetch is fine
 * and avoids pulling in a large dependency for ~5 methods.
 */

import { env } from '../shared/env.js';
import { logger } from '../shared/logger.js';

const BOT_API = () => `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;

export interface InlineButton {
  text: string;
  /** Callback data Telegram sends back when the button is pressed (max 64 bytes). */
  callback_data: string;
}

export type InlineKeyboard = InlineButton[][];

/**
 * Build a compact callback_data string. Telegram limits this to 64 bytes,
 * so we use short action names and truncate IDs.
 *
 * Format: `action:arg1:arg2`
 */
export function callbackData(action: string, ...args: string[]): string {
  const data = [action, ...args].join(':');
  if (data.length > 64) {
    logger.warn({ data, length: data.length }, 'callback_data exceeds 64 bytes, truncating');
    return data.slice(0, 64);
  }
  return data;
}

export function parseCallbackData(data: string): { action: string; args: string[] } {
  const parts = data.split(':');
  return { action: parts[0] ?? '', args: parts.slice(1) };
}

/**
 * Send a message with an optional inline keyboard.
 * Returns the Telegram message_id so we can edit it later.
 */
export async function sendMessage(
  text: string,
  keyboard?: InlineKeyboard,
): Promise<number | null> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return null;

  const body: Record<string, unknown> = {
    chat_id: env.TELEGRAM_CHAT_ID,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  if (keyboard && keyboard.length > 0) {
    body.reply_markup = { inline_keyboard: keyboard };
  }

  try {
    const res = await fetch(`${BOT_API()}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const errText = await res.text();
      logger.error({ status: res.status, errText }, 'Telegram sendMessage failed');
      return null;
    }
    const json = (await res.json()) as { result?: { message_id?: number } };
    return json.result?.message_id ?? null;
  } catch (err) {
    logger.error({ err }, 'Telegram sendMessage error');
    return null;
  }
}

/**
 * Answer a callback query — Telegram requires this within 30s of a button
 * press or it shows a "loading" spinner.
 */
export async function answerCallback(
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) return;

  try {
    await fetch(`${BOT_API()}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text: text ?? 'Done',
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    logger.error({ err }, 'Telegram answerCallbackQuery error');
  }
}

/**
 * Edit a previously sent message's text and optionally remove the keyboard.
 */
export async function editMessage(
  chatId: string | number,
  messageId: number,
  text: string,
  removeKeyboard = true,
): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) return;

  const body: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  if (removeKeyboard) {
    body.reply_markup = { inline_keyboard: [] };
  }

  try {
    await fetch(`${BOT_API()}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    logger.error({ err }, 'Telegram editMessageText error');
  }
}

/**
 * Register a webhook URL with Telegram so it sends callback updates to us.
 *
 * Called once on API startup when TELEGRAM_WEBHOOK_SECRET is set. Idempotent;
 * Telegram replaces the old webhook if one exists.
 */
export async function registerWebhook(webhookUrl: string): Promise<boolean> {
  if (!env.TELEGRAM_BOT_TOKEN) return false;

  try {
    const res = await fetch(`${BOT_API()}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: env.TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: ['callback_query'],
        drop_pending_updates: true,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json()) as { ok?: boolean; description?: string };
    if (json.ok) {
      logger.info({ webhookUrl }, 'Telegram webhook registered');
      return true;
    }
    logger.error({ json }, 'Telegram setWebhook failed');
    return false;
  } catch (err) {
    logger.error({ err }, 'Telegram setWebhook error');
    return false;
  }
}
