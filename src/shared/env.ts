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
  // Weekly coverage sweep: re-search MISSING catalog EANs at every searchable
  // chain to pick up products that came back in stock. Default: Sunday 02:00.
  SWEEP_CRON: z.string().default('0 2 * * 0'),
  DEFAULT_RATE_LIMIT_MS: z.coerce.number().int().nonnegative().default(500),
  DEFAULT_CONCURRENCY: z.coerce.number().int().positive().default(3),

  // Revista (magazine) pipeline — AI reads promo PDFs/flipbooks for chains that
  // don't publish prices on the web. See src/revistas/ and docs/REVISTA_REVIEW.md.
  // OPENAI_API_KEY is optional at startup (smoke tests run without it); the
  // revista pipeline asserts it's present when it actually runs.
  OPENAI_API_KEY: z.string().optional().default(''),
  REVISTA_VISION_MODEL: z.string().default('gpt-4o'),
  REVISTA_JUDGE_MODEL: z.string().default('gpt-4o-mini'),
  REVISTA_EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  // Minimum judge confidence to queue a match for human review. Low on purpose:
  // the human is the real filter — we'd rather a person dismiss a dud in a
  // second than silently drop a real match.
  REVISTA_MATCH_THRESHOLD: z.coerce.number().min(0).max(1).default(0.3),
  // Bounded concurrency for vision/judge calls (keeps us under OpenAI rate limits).
  REVISTA_CONCURRENCY: z.coerce.number().int().positive().default(5),
  // Supabase Storage bucket the rendered page images are uploaded to.
  REVISTA_STORAGE_BUCKET: z.string().default('revista-pages'),
  // Toggle the daily magazine check inside the orchestrator run.
  REVISTA_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

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

  // MercadoLibre official API (OAuth). The Client ID / Secret come from the
  // app registered in the ML DevCenter; the redirect URI must match exactly
  // what's registered there. The access/refresh tokens themselves are NOT env
  // vars — they're minted by `npm run ml:auth` and stored (and auto-rotated)
  // in supermarkets.config.mlTokens. See src/adapters/mercadolibre-auth.ts.
  ML_CLIENT_ID: z.string().optional().default(''),
  ML_CLIENT_SECRET: z.string().optional().default(''),
  ML_REDIRECT_URI: z.string().optional().default('https://httpbin.org/anything'),
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
