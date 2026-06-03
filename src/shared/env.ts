/**
 * Validates and exports environment variables.
 *
 * On import, this module reads process.env and throws if anything required
 * is missing or malformed. Importing it from any process (worker, api,
 * orchestrator) gives you a fully typed `env` object.
 */

import { z } from 'zod';

const Severity = z.enum(['info', 'warning', 'critical']);

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
  TZ: z.string().default('America/Argentina/Buenos_Aires'),

  // Database — optional at startup so smoke-test scripts can run without it.
  // The `db` module asserts these are set when it tries to construct a client.
  SUPABASE_URL: z.string().url().optional().or(z.literal('')),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional().or(z.literal('')),

  // Redis — same idea as above.
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

  // API
  API_PORT: z.coerce.number().int().positive().default(3000),

  // Scraping
  SCRAPE_CRON: z.string().default('0 6 * * *'),
  DEFAULT_RATE_LIMIT_MS: z.coerce.number().int().nonnegative().default(500),
  DEFAULT_CONCURRENCY: z.coerce.number().int().positive().default(3),

  // Observability
  SENTRY_DSN: z.string().optional().default(''),

  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().optional().default(''),
  TELEGRAM_CHAT_ID: z.string().optional().default(''),
  TELEGRAM_MIN_SEVERITY: Severity.default('warning'),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional().default(''),

  // Public-facing URL of the API (used to register the Telegram webhook).
  // Only needed if TELEGRAM_WEBHOOK_SECRET is set.
  API_BASE_URL: z.string().url().optional().or(z.literal('')).default(''),

  // Per-supermarket auth (optional — DB-driven config preferred)
  // Carrefour Maxi Pedido: prices are gated behind a PHPSESSID cookie. The
  // adapter self-heals: when the cookie expires it logs in via Playwright
  // and writes the fresh value to `supermarkets.config.phpSessId`. This env
  // var is just a fallback / bootstrap seed for local debugging.
  // See src/adapters/maxi-carrefour-auth.ts for the full lifecycle.
  MAXI_CARREFOUR_PHPSESSID: z.string().optional().default(''),
});

export type Env = z.infer<typeof EnvSchema>;

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  // Format errors clearly so missing-config issues are obvious on startup
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  // eslint-disable-next-line no-console
  console.error(`Invalid environment configuration:\n${issues}`);
  process.exit(1);
}

export const env: Env = parsed.data;

export const isProduction = env.NODE_ENV === 'production';
export const isDevelopment = env.NODE_ENV === 'development';
export const isTest = env.NODE_ENV === 'test';
