/**
 * Create a new API key for the REST API.
 *
 * Generates a high-entropy random key, stores ONLY its SHA-256 hash in the
 * `api_keys` table, and prints the plaintext key ONCE so you can copy it.
 * The plaintext is never recoverable after this.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/create-api-key.ts <name>
 *
 * Examples:
 *   npx tsx --env-file=.env scripts/create-api-key.ts frontend-prod
 *   npx tsx --env-file=.env scripts/create-api-key.ts internal-test
 */

import { randomBytes } from 'node:crypto';
import { db } from '../src/shared/db.js';
import { logger } from '../src/shared/logger.js';
import { hashKey } from '../src/api/middleware/auth.js';

async function main(): Promise<void> {
  const name = process.argv[2]?.trim();
  if (!name) {
    logger.error('Usage: npx tsx --env-file=.env scripts/create-api-key.ts <name>');
    process.exit(1);
  }

  // 32 bytes = 256 bits of entropy → 64 hex chars. Plenty for an API key.
  const plaintext = randomBytes(32).toString('hex');
  const keyHash = hashKey(plaintext);

  const { data, error } = await db
    .from('api_keys')
    .insert({
      name,
      key_hash: keyHash,
      is_active: true,
      rate_limit: 60,
    })
    .select('id, name, created_at')
    .single();

  if (error) {
    logger.error({ err: error }, 'failed to create API key');
    process.exit(1);
  }

  // Print to stdout (NOT through structured logger) so the user can copy
  // cleanly. The whole point is making the plaintext visible exactly once.
  // eslint-disable-next-line no-console
  console.log('\n=========== API KEY CREATED ===========');
  // eslint-disable-next-line no-console
  console.log(`Name:    ${data.name}`);
  // eslint-disable-next-line no-console
  console.log(`Id:      ${data.id}`);
  // eslint-disable-next-line no-console
  console.log(`Created: ${data.created_at}`);
  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log('  >>>  KEY (shown ONCE, save it now)  <<<');
  // eslint-disable-next-line no-console
  console.log(`  ${plaintext}`);
  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log('Use it via:  X-API-Key: <key>');
  // eslint-disable-next-line no-console
  console.log('=======================================\n');
}

void main();
