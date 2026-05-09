/**
 * GET /v1/health
 *
 * Public, unauthenticated. Used by uptime monitors and load balancers.
 * Confirms the process is alive and the DB is reachable.
 */

import { Router, type Request, type Response } from 'express';
import { db } from '../../shared/db.js';
import { success } from '../lib/envelope.js';

export const healthRouter = Router();

healthRouter.get('/', async (_req: Request, res: Response) => {
  // Cheap probe — count rows on a tiny table.
  let dbOk = true;
  try {
    const { error } = await db
      .from('supermarkets')
      .select('id', { count: 'exact', head: true });
    if (error) dbOk = false;
  } catch {
    dbOk = false;
  }

  const status = dbOk ? 'ok' : 'degraded';
  res
    .status(dbOk ? 200 : 503)
    .json(
      success({
        status,
        uptimeSeconds: Math.round(process.uptime()),
        services: { db: dbOk },
      }),
    );
});
