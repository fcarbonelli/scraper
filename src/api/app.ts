/**
 * Express app factory.
 *
 * Returns a fully configured `Express` instance — no port binding here.
 * Kept separate from `server.ts` so:
 *   - tests can import `buildApp()` and use `supertest` against it
 *   - the entry-point file in server.ts has zero side effects on import
 */

import express, { type Express } from 'express';
import cors from 'cors';
import './types.js'; // module augmentation for req.apiKey, req.pagination

import { requireApiKey } from './middleware/auth.js';
import { pagination } from './middleware/pagination.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { requestLogger } from './middleware/requestLogger.js';

import { healthRouter } from './routes/health.js';
import { productsRouter } from './routes/products.js';
import { supermarketsRouter } from './routes/supermarkets.js';
import { supermarketProductsRouter } from './routes/supermarketProducts.js';
import { snapshotsRouter } from './routes/snapshots.js';
import { runsRouter } from './routes/runs.js';
import { alertsRouter } from './routes/alerts.js';
import { dataRouter } from './routes/data.js';
import { catalogRouter } from './routes/catalog.js';
import { revistasRouter } from './routes/revistas.js';
import { telegramRouter } from './routes/telegram.js';

export function buildApp(): Express {
  const app = express();

  // Trust the reverse proxy (Caddy) so req.ip resolves to the real client IP.
  app.set('trust proxy', true);

  // Logging first — we want to record auth failures too.
  app.use(requestLogger);

  // CORS — permissive in v1. Tighten via env var when frontend is deployed.
  app.use(
    cors({
      origin: true,         // reflect the request origin (any)
      credentials: false,   // API key auth, no cookies
      maxAge: 86_400,
      allowedHeaders: ['Content-Type', 'X-API-Key', 'x-api-key'],
    }),
  );

  // JSON body parsing for PATCH endpoints.
  app.use(express.json({ limit: '64kb' }));

  // Public routes — no auth.
  app.use('/v1/health', healthRouter);
  app.use('/telegram', telegramRouter);

  // Everything below requires a valid API key + has pagination available.
  app.use('/v1', requireApiKey, pagination);

  app.use('/v1/products', productsRouter);
  app.use('/v1/supermarkets', supermarketsRouter);
  app.use('/v1/supermarket-products', supermarketProductsRouter);
  app.use('/v1/snapshots', snapshotsRouter);
  app.use('/v1/runs', runsRouter);
  app.use('/v1/alerts', alertsRouter);
  app.use('/v1/data', dataRouter);
  app.use('/v1/catalog', catalogRouter);
  app.use('/v1/revistas', revistasRouter);

  // 404 + error handlers (must be last).
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
