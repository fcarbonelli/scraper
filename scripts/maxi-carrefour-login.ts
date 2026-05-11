/**
 * Manual Maxi Carrefour login — drives Playwright to harvest a fresh
 * PHPSESSID and either prints it (dry-run) or writes it to the database.
 *
 * The adapter does this automatically when it sees `data-price="private"`,
 * so you usually don't need this script. Reach for it when:
 *   - First-time DB seeding (so the very first scrape doesn't pay the
 *     login cost).
 *   - Debugging a failing login flow with `--headed` to watch what's
 *     happening on the page.
 *   - Forcing a refresh on demand after manual config changes.
 *   - Finding a sucursal (seller) that carries your specific products.
 *
 * Usage:
 *   npm run maxi-carrefour:login                # headless, persist to DB
 *   npm run maxi-carrefour:login -- --dry-run   # login, print cookie, no DB
 *   npm run maxi-carrefour:login -- --headed    # show the browser window
 *   npm run maxi-carrefour:login -- --no-chrome # use bundled chromium
 *   npm run maxi-carrefour:login -- --region=BS_AS_NORTE --seller=219
 *                                               # pin a specific sucursal
 */

import { logger } from '../src/shared/logger.js';
import {
  loginAndGetCookie,
  persistCookie,
  type LoginResult,
} from '../src/adapters/maxi-carrefour-auth.js';

interface Flags {
  dryRun: boolean;
  headless: boolean;
  useSystemChrome: boolean;
  region?: string;
  seller?: string;
}

function parseFlags(argv: readonly string[]): Flags {
  const flags: Flags = {
    dryRun: argv.includes('--dry-run'),
    headless: !argv.includes('--headed') && !argv.includes('--no-headless'),
    useSystemChrome: !argv.includes('--no-chrome'),
  };
  for (const arg of argv) {
    if (arg.startsWith('--region=')) flags.region = arg.slice('--region='.length);
    if (arg.startsWith('--seller=')) flags.seller = arg.slice('--seller='.length);
  }
  return flags;
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  // Build a pick override: when --region or --seller are present, pin them.
  const pick =
    flags.region || flags.seller
      ? {
          ...(flags.region ? { region: flags.region } : {}),
          ...(flags.seller ? { seller: flags.seller } : {}),
        }
      : ('first' as const);

  const loginCfg = {
    name: 'Juan Perez',
    numberId: '30123456',
    phone: '01111111111',
    email: 'price-watch-bot@example.com',
    pick,
  };

  logger.info({ flags, pick }, 'maxi-carrefour: starting manual login');

  let result: LoginResult;
  try {
    result = await loginAndGetCookie(loginCfg, logger, {
      headless: flags.headless,
      useSystemChrome: flags.useSystemChrome,
    });
  } catch (err) {
    logger.error({ err }, 'maxi-carrefour: login failed');
    process.exitCode = 1;
    return;
  }

  console.log('\n--- LoginResult ---');
  console.log(JSON.stringify(result, null, 2));
  console.log(`\nPHPSESSID = ${result.phpSessId}`);

  if (flags.dryRun) {
    console.log('\n(dry-run: not persisting to DB)');
    return;
  }

  try {
    await persistCookie('maxi-carrefour', result, logger);
    console.log('\nPersisted to supermarkets.config.phpSessId');
  } catch (err) {
    logger.error({ err }, 'maxi-carrefour: failed to persist cookie to DB');
    process.exitCode = 1;
  }
}

void main();
