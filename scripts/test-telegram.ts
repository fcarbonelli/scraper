/**
 * Smoke test for the Telegram notifier.
 *
 * Sends one of each severity level so you can confirm:
 *   - your bot token works
 *   - your chat_id is correct
 *   - the message formatting looks how you want
 *
 * Pass `--buttons` to also send a test message with interactive action
 * buttons (retry / fill / acknowledge). Requires TELEGRAM_WEBHOOK_SECRET
 * and API_BASE_URL to be set so Telegram knows where to send callbacks.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/test-telegram.ts
 *   npx tsx --env-file=.env scripts/test-telegram.ts --buttons
 */

import { notifyAlert } from '../src/alerts/notify.js';
import { callbackData } from '../src/telegram/bot.js';
import { env } from '../src/shared/env.js';
import { logger } from '../src/shared/logger.js';

async function main(): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    logger.error(
      'TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set in .env. ' +
        'See AGENTS.md or BotFather for setup steps.',
    );
    process.exit(1);
  }

  const withButtons = process.argv.includes('--buttons');

  logger.info(
    { minSeverity: env.TELEGRAM_MIN_SEVERITY, withButtons },
    'sending test alerts',
  );

  const results: Record<string, boolean> = {};

  results.info = await notifyAlert({
    severity: 'info',
    title: 'Test info message',
    body: 'This is the lowest priority. You may not see it if TELEGRAM_MIN_SEVERITY is "warning" or higher.',
  });

  results.warning = await notifyAlert({
    severity: 'warning',
    title: 'Test warning',
    body: 'This is a warning-level alert from the scraper.',
    context: {
      supermarket: 'coto',
      failed_jobs: 3,
      total_jobs: 100,
    },
  });

  results.critical = await notifyAlert({
    severity: 'critical',
    title: 'Test critical alert',
    body: 'This simulates "SuperZ degraded — 97/100 products failing".',
    context: {
      supermarket: 'superz',
      failure_rate: '97%',
      top_error: 'selector_failed (89)',
    },
    url: 'https://example.com/alerts/abc-123',
  });

  if (withButtons) {
    if (!env.TELEGRAM_WEBHOOK_SECRET || !env.API_BASE_URL) {
      logger.warn(
        'TELEGRAM_WEBHOOK_SECRET and API_BASE_URL must be set for buttons to work. ' +
          'Sending buttons anyway so you can see how they look, but pressing them will fail.',
      );
    }

    // fake alert ID — pressing the buttons will return "alert not found"
    // which is fine for a visual test
    const fakeAlertId = '00000000-0000-0000-0000-000000000000';
    results.buttons = await notifyAlert({
      severity: 'warning',
      title: 'Test alert WITH buttons',
      body: '3 products failed for coto. Try pressing the buttons below!',
      context: {
        supermarket: 'coto',
        failed: 3,
        total: 50,
      },
      actions: [
        { label: '🔄 Retry failed', data: callbackData('retry', fakeAlertId) },
        { label: '📋 Fill yesterday', data: callbackData('fill', fakeAlertId) },
        { label: '✓ Acknowledge', data: callbackData('ack', fakeAlertId) },
      ],
    });
  }

  logger.info({ results }, 'test alerts sent');
  if (!results.warning && !results.critical) {
    logger.error('No critical/warning alerts were sent — check token + chat_id');
    process.exit(1);
  }
}

void main();
