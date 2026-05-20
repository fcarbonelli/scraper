/**
 * Single-job processor.
 *
 * Pure orchestration: takes a job, calls the right adapter, records the
 * outcome to the DB, and returns a verdict that the worker (or test caller)
 * uses to decide whether to re-enqueue.
 *
 * Kept side-effect-light against BullMQ so it can be unit-tested by passing
 * in a fake job object.
 */

import { logger } from '../shared/logger.js';
import { getAdapter } from '../adapters/registry.js';
import type { ScrapeContext } from '../adapters/types.js';
import type { ScrapeJobData } from '../shared/queue.js';
import { classifyError } from './classifyError.js';
import { decideRetry } from './retryPolicy.js';
import { generateEarlyAlertForRunSupermarket } from '../alerts/aggregate.js';
import {
  loadJobInput,
  recordJobStart,
  recordJobSuccess,
  recordJobFailure,
} from './persist.js';

export interface ProcessJobOptions {
  /** Which attempt this is (1 = first try). Set when re-enqueueing. */
  attempt?: number;
}

export interface ProcessJobResult {
  status: 'success' | 'failed' | 'retry_scheduled';
  /** Set when status === 'retry_scheduled'. */
  retry?: { delayMs: number; nextAttempt: number };
}

/**
 * Process exactly one scrape job end-to-end.
 *
 * Returns a verdict so the BullMQ wrapper can decide whether to re-enqueue
 * (we use our own retry semantics — see retryPolicy.ts).
 */
export async function processJob(
  jobData: ScrapeJobData,
  opts: ProcessJobOptions = {},
): Promise<ProcessJobResult> {
  const attempt = opts.attempt ?? 1;
  const log = logger.child({
    supermarket: jobData.supermarketId,
    sku: jobData.externalId,
    supermarketProductId: jobData.supermarketProductId,
    runId: jobData.scrapeRunId,
    attempt,
  });

  // -- Load DB context ------------------------------------------------------
  const input = await loadJobInput(jobData.supermarketProductId);
  if (!input) {
    log.warn(
      { supermarketProductId: jobData.supermarketProductId },
      'skipping job: supermarket_product or supermarket inactive/missing',
    );
    return { status: 'failed' };
  }

  // -- Resolve adapter ------------------------------------------------------
  let adapter;
  try {
    adapter = getAdapter(input.supermarket.id);
  } catch (err) {
    log.error({ err }, 'no adapter registered for supermarket');
    return { status: 'failed' };
  }

  // -- Persist "running" row ------------------------------------------------
  const startedAt = Date.now();
  const jobExecutionId = await recordJobStart({
    scrapeRunId: jobData.scrapeRunId,
    supermarketProductId: jobData.supermarketProductId,
    attempt,
  });

  // -- Build context -------------------------------------------------------
  const ctx: ScrapeContext = {
    supermarketProductId: input.supermarketProduct.id,
    externalId: input.supermarketProduct.externalId,
    externalUrl: input.supermarketProduct.externalUrl,
    config: {
      id: input.supermarket.id,
      name: input.supermarket.name,
      baseUrl: input.supermarket.baseUrl,
      rateLimitMs: input.supermarket.rateLimitMs,
      concurrency: input.supermarket.concurrency,
      config: input.supermarket.config,
    },
    logger: log,
  };

  // -- Scrape ---------------------------------------------------------------
  try {
    const result = await adapter.scrape(ctx);
    const durationMs = Date.now() - startedAt;

    await recordJobSuccess({
      jobExecutionId,
      scrapeRunId: jobData.scrapeRunId,
      supermarketProductId: jobData.supermarketProductId,
      result,
      durationMs,
      logger: log,
    });

    log.info(
      {
        tier: result.tierUsed,
        price: result.price,
        durationMs,
        inStock: result.inStock,
        externalUrl: input.supermarketProduct.externalUrl,
        jobExecutionId,
      },
      'scrape ok',
    );
    return { status: 'success' };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const classified = classifyError(err);
    const decision = decideRetry(classified.type, attempt, classified.retryable);

    await recordJobFailure({
      jobExecutionId,
      error: classified,
      durationMs,
      isFinal: !decision.shouldRetry,
    });

    if (!decision.shouldRetry) {
      try {
        await generateEarlyAlertForRunSupermarket(
          jobData.scrapeRunId,
          input.supermarket.id,
        );
      } catch (alertErr) {
        log.error({ err: alertErr }, 'early alert evaluation failed');
      }
    }

    log.warn(
      {
        type: classified.type,
        message: classified.message,
        httpStatus: classified.httpStatus ?? null,
        retryable: classified.retryable,
        nextAttempt: decision.shouldRetry ? decision.nextAttempt : null,
        durationMs,
        externalUrl: input.supermarketProduct.externalUrl,
        jobExecutionId,
      },
      decision.shouldRetry ? 'scrape failed, will retry' : 'scrape failed (final)',
    );

    return decision.shouldRetry
      ? {
          status: 'retry_scheduled',
          retry: { delayMs: decision.delayMs, nextAttempt: decision.nextAttempt },
        }
      : { status: 'failed' };
  }
}
