/**
 * Telegram webhook route.
 *
 *   POST /telegram/callback
 *
 * Receives callback_query updates from Telegram when a user presses an
 * inline keyboard button. The route:
 *   1. Verifies the secret token header (set during webhook registration)
 *   2. Parses the callback data to determine the action
 *   3. Executes the action (retry, fill, acknowledge)
 *   4. Answers the callback query and edits the original message
 *
 * This route is PUBLIC (no API key) because Telegram sends the request.
 * Security is via X-Telegram-Bot-Api-Secret-Token header matching our secret.
 */

import { Router, type Request, type Response } from 'express';
import { env } from '../../shared/env.js';
import { logger } from '../../shared/logger.js';
import { parseCallbackData, answerCallback, editMessage } from '../../telegram/bot.js';
import { handleAction } from '../../telegram/actions.js';

export const telegramRouter = Router();

const log = logger.child({ route: 'telegram-webhook' });

telegramRouter.post('/callback', async (req: Request, res: Response) => {
  // Telegram sends secret in this header (set via setWebhook's secret_token)
  const secret = req.header('X-Telegram-Bot-Api-Secret-Token');
  if (!env.TELEGRAM_WEBHOOK_SECRET || secret !== env.TELEGRAM_WEBHOOK_SECRET) {
    log.warn('telegram webhook: invalid or missing secret token');
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const update = req.body as TelegramUpdate;
  const callbackQuery = update?.callback_query;
  if (!callbackQuery?.data) {
    // Not a callback query — just acknowledge so Telegram doesn't retry
    res.status(200).json({ ok: true });
    return;
  }

  const { action, args } = parseCallbackData(callbackQuery.data);
  const chatId = callbackQuery.message?.chat?.id;
  const messageId = callbackQuery.message?.message_id;
  const originalText = callbackQuery.message?.text ?? '';
  const userName = callbackQuery.from?.first_name ?? 'Unknown';

  log.info(
    { action, args, chatId, messageId, userName },
    'telegram callback received',
  );

  // Answer immediately so Telegram stops the "loading" spinner
  const result = await handleAction(action, args);

  await answerCallback(
    callbackQuery.id,
    result.success ? result.text.slice(0, 200) : `Failed: ${result.text.slice(0, 180)}`,
  );

  // Edit the original message to show what happened and remove buttons
  if (chatId && messageId) {
    const statusEmoji = result.success ? '✅' : '❌';
    const editedText =
      `${originalText}\n\n` +
      `${statusEmoji} <b>${escapeHtml(userName)}</b> triggered <b>${escapeHtml(action)}</b>\n` +
      escapeHtml(result.text);

    await editMessage(chatId, messageId, editedText, true);
  }

  res.status(200).json({ ok: true });
});

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Minimal Telegram types — only the fields we use
interface TelegramUpdate {
  callback_query?: {
    id: string;
    data?: string;
    from?: { first_name?: string };
    message?: {
      message_id: number;
      chat: { id: number };
      text?: string;
    };
  };
}
