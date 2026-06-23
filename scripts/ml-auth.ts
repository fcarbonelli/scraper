/**
 * MercadoLibre OAuth bootstrap (one-time authorization).
 *
 * ML's API needs a user-authorized token. This is a single manual step; after
 * it the adapter auto-refreshes forever (refresh tokens last ~6 months and
 * rotate on every use, so as long as the scraper runs at least that often it
 * never needs re-authorizing).
 *
 * Two-step usage:
 *
 *   1. Print the authorization URL:
 *        npm run ml:auth
 *      Open it in a browser, log into the ML account you want prices for, and
 *      click "Autorizar". You'll be redirected to the app's redirect URI
 *      (e.g. https://httpbin.org/anything?code=TG-xxxx&state=yyyy).
 *
 *   2. Exchange the code (paste the WHOLE redirected URL, or just the code):
 *        npm run ml:auth -- --url="https://httpbin.org/anything?code=TG-xxxx&state=yyyy"
 *        # or
 *        npm run ml:auth -- --code=TG-xxxx
 *
 *      This trades the code for tokens and stores them in
 *      supermarkets.config.mlTokens. Authorization codes are single-use and
 *      expire in ~10 minutes, so run step 2 promptly.
 */

import { randomUUID } from 'node:crypto';
import { env } from '../src/shared/env.js';
import { buildAuthUrl, exchangeCodeForTokens } from '../src/adapters/mercadolibre-auth.js';
import { logger } from '../src/shared/logger.js';

/** Pull a named `--flag=value` (or `--flag value`) from argv. */
function getArg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const prefix = `--${name}=`;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith(prefix)) return a.slice(prefix.length);
    if (a === `--${name}` && argv[i + 1]) return argv[i + 1];
  }
  return undefined;
}

/** Extract the `code` query param from a redirected URL, if a URL was given. */
function codeFromUrl(raw: string): string | undefined {
  try {
    return new URL(raw).searchParams.get('code') ?? undefined;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  if (!env.ML_CLIENT_ID || !env.ML_CLIENT_SECRET) {
    logger.error(
      'ML_CLIENT_ID / ML_CLIENT_SECRET are not set. Add them to .env before running ml:auth.',
    );
    process.exitCode = 1;
    return;
  }

  const urlArg = getArg('url');
  const code = getArg('code') ?? (urlArg ? codeFromUrl(urlArg) : undefined);

  // --- Step 2: we have a code → exchange it for tokens ---------------------
  if (code) {
    logger.info('Exchanging authorization code for tokens…');
    const tokens = await exchangeCodeForTokens(code);
    logger.info(
      { userId: tokens.userId, expiresAt: tokens.expiresAt },
      'MercadoLibre authorized — tokens stored in supermarkets.config.mlTokens. ' +
        'The adapter will auto-refresh from here.',
    );
    return;
  }

  // --- Step 1: no code → print the authorization URL -----------------------
  const state = randomUUID();
  const authUrl = buildAuthUrl(state);
  // eslint-disable-next-line no-console
  console.log(
    [
      '',
      'MercadoLibre authorization — step 1 of 2',
      '----------------------------------------',
      `Redirect URI (must match the app): ${env.ML_REDIRECT_URI}`,
      '',
      '1. Open this URL in a browser and click "Autorizar":',
      '',
      `   ${authUrl}`,
      '',
      '2. You will be redirected to the redirect URI with a ?code=... param.',
      '   Copy the FULL redirected URL and run:',
      '',
      '   npm run ml:auth -- --url="<paste the redirected URL here>"',
      '',
      '   (the code is single-use and expires in ~10 minutes, so do this promptly)',
      '',
    ].join('\n'),
  );
}

void main().catch((err: unknown) => {
  logger.error({ err: (err as Error).message }, 'ml:auth failed');
  process.exitCode = 1;
});
