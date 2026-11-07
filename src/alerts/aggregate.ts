/**
 * Per-supermarket run evaluation.
 *
 * Runs once when a scrape_run finalizes (never mid-run):
 *   1. loadEffectiveRunStats — final outcome per product, grouped by chain.
 *      For a recovery run the numbers are merged with its source run, so
 *      "did the chain work today" reflects both passes.
 *   2. recordRunStats — persists per-chain totals in
 *      scrape_runs.metadata.stats_by_supermarket; that history is the
 *      baseline for the "drop" rule.
 *   3. generateAlertsForRun — per chain: schedule an automatic recovery for
 *      transient whole-site failures, otherwise apply the incident policy
 *      (policy.ts) and open / refresh / auto-resolve the chain's incident
 *      (incidents.ts). Chronic partial failures never reach Telegram.
 *   4. updateSupermarketHealth — the supermarkets.health_status badge.
 */

import { db, fetchInChunks } from '../shared/db.js';
import { logger } from '../shared/logger.js';
import { loadRunDiagnostics } from '../shared/runDiagnostics.js';
import { scheduleSupermarketRecovery, shouldAutoRecover } from '../orchestrator/recovery.js';
import type { AlertType } from './createAlert.js';
import { raiseIncident, resolveIncident } from './incidents.js';
import {
  baselineSuccessRate,
  classifyIncident,
  dominantErrorType,
  NOT_RUN,
  topErrorsSummary,
  type IncidentKind,
  type IncidentVerdict,
} from './policy.js';

/** Recovery is only worth it when a real chunk of the chain failed. */
const RECOVERY_MIN_FAILURE_RATE = 0.3;
const HEALTH_DOWN_FAILURE_RATE = 0.8;
const HEALTH_DEGRADED_FAILURE_RATE = 0.3;
const MAX_SAMPLES = 8;
const SAMPLES_PER_TYPE = 3;
const SAMPLE_MESSAGE_MAX_CHARS = 300;
/** Completed runs scanned to build each chain's baseline (recoveries skipped). */
const BASELINE_LOOKBACK_RUNS = 30;

const ALERT_TYPE_BY_KIND: Record<IncidentKind, AlertType> = {
  down: 'supermarket_down',
  blocked: 'supermarket_blocked',
  drop: 'supermarket_drop',
};

export interface FailureSample {
  supermarket_product_id: string;
  job_execution_id: string | null;
  error_type: string;
  error_message: string | null;
  external_url: string | null;
}

export interface SupermarketStat {
  supermarketId: string;
  supermarketName: string;
  total: number;
  succeeded: number;
  failed: number;
  /** Final-attempt error_type counts, plus NOT_RUN for unfinished products. */
  errorTypeCounts: Map<string, number>;
  /** A few failing products per error type, biggest types first. */
  samples: FailureSample[];
}

export interface RunStats {
  runId: string;
  startedAt: string;
  isRecovery: boolean;
  sourceRunId: string | null;
  stats: SupermarketStat[];
}

/** Shape persisted in scrape_runs.metadata.stats_by_supermarket. */
interface StoredStat {
  total: number;
  succeeded: number;
  failed: number;
}

interface MappingRow {
  id: string;
  supermarket_id: string;
  external_url: string | null;
}

/**
 * Per-chain stats for one run, from the latest attempt of every product
 * (paged — runs have far more than 1000 job_executions).
 */
async function loadRunStats(runId: string): Promise<RunStats | null> {
  const diagnostics = await loadRunDiagnostics(runId);
  if (!diagnostics) return null;
  const { run, finalOutcomes, progress } = diagnostics;

  const mappingIds = Array.from(new Set(finalOutcomes.map((o) => o.supermarket_product_id)));
  const mappings = await fetchInChunks<MappingRow>(mappingIds, (chunk) =>
    db.from('supermarket_products').select('id, supermarket_id, external_url').in('id', chunk),
  );
  const mappingById = new Map(mappings.map((m) => [m.id, m]));
  const names = await loadSupermarketNames();

  const byChain = new Map<string, SupermarketStat>();
  const pools = new Map<string, Map<string, FailureSample[]>>();
  const statFor = (supermarketId: string): SupermarketStat => {
    let stat = byChain.get(supermarketId);
    if (!stat) {
      stat = {
        supermarketId,
        supermarketName: names.get(supermarketId) ?? supermarketId,
        total: 0,
        succeeded: 0,
        failed: 0,
        errorTypeCounts: new Map(),
        samples: [],
      };
      byChain.set(supermarketId, stat);
    }
    return stat;
  };

  for (const outcome of finalOutcomes) {
    // Still-retrying products are counted below as NOT_RUN via `progress`.
    if (outcome.status === 'retrying') continue;
    const mapping = mappingById.get(outcome.supermarket_product_id);
    if (!mapping) continue;
    const stat = statFor(mapping.supermarket_id);
    stat.total += 1;
    if (outcome.status === 'success') {
      stat.succeeded += 1;
      continue;
    }
    stat.failed += 1;
    const type = outcome.error_type ?? 'unknown';
    stat.errorTypeCounts.set(type, (stat.errorTypeCounts.get(type) ?? 0) + 1);

    let pool = pools.get(mapping.supermarket_id);
    if (!pool) pools.set(mapping.supermarket_id, (pool = new Map()));
    const bucket = pool.get(type) ?? [];
    if (bucket.length < SAMPLES_PER_TYPE) {
      bucket.push({
        supermarket_product_id: outcome.supermarket_product_id,
        job_execution_id: outcome.id,
        error_type: type,
        error_message: outcome.error_message?.slice(0, SAMPLE_MESSAGE_MAX_CHARS) ?? null,
        external_url: mapping.external_url,
      });
      pool.set(type, bucket);
    }
  }

  // Planned products with no final outcome: never started, or still retrying
  // when the 6h ceiling force-finalized the run. A dead worker/queue shows up
  // here and nowhere else.
  for (const [supermarketId, p] of Object.entries(progress.by_supermarket)) {
    const unfinished = p.pending + p.running_or_retrying;
    if (unfinished === 0 || supermarketId === 'unknown') continue;
    const stat = statFor(supermarketId);
    stat.total += unfinished;
    stat.failed += unfinished;
    stat.errorTypeCounts.set(NOT_RUN, (stat.errorTypeCounts.get(NOT_RUN) ?? 0) + unfinished);
  }

  for (const stat of byChain.values()) {
    stat.samples = pickSamples(stat.errorTypeCounts, pools.get(stat.supermarketId));
  }

  const metadata = run.metadata ?? {};
  return {
    runId: run.id,
    startedAt: run.started_at,
    isRecovery: metadata.recovery === true,
    sourceRunId: typeof metadata.source_run_id === 'string' ? metadata.source_run_id : null,
    stats: Array.from(byChain.values()),
  };
}

/** Up to MAX_SAMPLES failures, walking error types from most to least common. */
function pickSamples(
  counts: Map<string, number>,
  pool: Map<string, FailureSample[]> | undefined,
): FailureSample[] {
  if (!pool) return [];
  const out: FailureSample[] = [];
  const types = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  for (const [type] of types) {
    for (const sample of pool.get(type) ?? []) {
      if (out.length >= MAX_SAMPLES) return out;
      out.push(sample);
    }
  }
  return out;
}

async function loadSupermarketNames(): Promise<Map<string, string>> {
  const { data, error } = await db.from('supermarkets').select('id, name');
  if (error) throw error;
  return new Map((data ?? []).map((s) => [s.id as string, s.name as string]));
}

function readStoredStats(metadata: unknown): Record<string, StoredStat> {
  if (!isRecord(metadata) || !isRecord(metadata.stats_by_supermarket)) return {};
  const out: Record<string, StoredStat> = {};
  for (const [id, value] of Object.entries(metadata.stats_by_supermarket)) {
    if (
      isRecord(value) &&
      typeof value.total === 'number' &&
      typeof value.succeeded === 'number' &&
      typeof value.failed === 'number'
    ) {
      out[id] = { total: value.total, succeeded: value.succeeded, failed: value.failed };
    }
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Stats for a finalized run. A recovery run only re-scraped one chain's
 * failures, so its totals are merged onto the source run's stored totals:
 * total = source total, succeeded = source + recovered. The error counts and
 * samples stay the recovery's — they describe what is still broken.
 */
export async function loadEffectiveRunStats(runId: string): Promise<RunStats | null> {
  const runStats = await loadRunStats(runId);
  if (!runStats?.isRecovery || !runStats.sourceRunId) return runStats;

  const { data, error } = await db
    .from('scrape_runs')
    .select('metadata')
    .eq('id', runStats.sourceRunId)
    .maybeSingle();
  if (error) throw error;
  const source = readStoredStats(data?.metadata);

  runStats.stats = runStats.stats.map((stat) => {
    const src = source[stat.supermarketId];
    if (!src) return stat;
    const succeeded = Math.min(src.total, src.succeeded + stat.succeeded);
    return { ...stat, total: src.total, succeeded, failed: src.total - succeeded };
  });
  return runStats;
}

/**
 * Persist per-chain totals on the run (and, for a recovery, on its source run,
 * so the source's history reflects the day's effective outcome).
 */
export async function recordRunStats(runStats: RunStats): Promise<void> {
  const targets = [runStats.runId];
  if (runStats.isRecovery && runStats.sourceRunId) targets.push(runStats.sourceRunId);

  const entries = Object.fromEntries(
    runStats.stats.map((s) => [
      s.supermarketId,
      { total: s.total, succeeded: s.succeeded, failed: s.failed } satisfies StoredStat,
    ]),
  );

  for (const runId of targets) {
    const { data, error } = await db
      .from('scrape_runs')
      .select('metadata')
      .eq('id', runId)
      .maybeSingle();
    if (error) throw error;
    if (!data) continue;
    const metadata = isRecord(data.metadata) ? data.metadata : {};
    const previous = isRecord(metadata.stats_by_supermarket) ? metadata.stats_by_supermarket : {};
    const { error: updateErr } = await db
      .from('scrape_runs')
      .update({ metadata: { ...metadata, stats_by_supermarket: { ...previous, ...entries } } })
      .eq('id', runId);
    if (updateErr) throw updateErr;
  }
}

/** Median recent success rate per chain, from earlier non-recovery runs. */
async function loadBaselines(current: RunStats): Promise<Map<string, number | null>> {
  const { data, error } = await db
    .from('scrape_runs')
    .select('id, metadata')
    .eq('status', 'completed')
    .lt('started_at', current.startedAt)
    .order('started_at', { ascending: false })
    .limit(BASELINE_LOOKBACK_RUNS);
  if (error) throw error;

  const excluded = new Set([current.runId, current.sourceRunId]);
  const ratesByChain = new Map<string, number[]>();
  for (const run of data ?? []) {
    if (excluded.has(run.id as string)) continue;
    const metadata = run.metadata as Record<string, unknown> | null;
    if (metadata?.recovery === true) continue;
    for (const [id, s] of Object.entries(readStoredStats(metadata))) {
      if (s.total === 0) continue;
      const rates = ratesByChain.get(id) ?? [];
      rates.push(s.succeeded / s.total);
      ratesByChain.set(id, rates);
    }
  }

  const out = new Map<string, number | null>();
  for (const [id, rates] of ratesByChain) out.set(id, baselineSuccessRate(rates));
  return out;
}

export interface GenerateAlertsResult {
  incidentsRaised: number;
  incidentsResolved: number;
  recoveriesScheduled: number;
}

/** Apply the incident policy to every chain in a finalized run. */
export async function generateAlertsForRun(runStats: RunStats): Promise<GenerateAlertsResult> {
  const result: GenerateAlertsResult = {
    incidentsRaised: 0,
    incidentsResolved: 0,
    recoveriesScheduled: 0,
  };
  const baselines = await loadBaselines(runStats);

  for (const stat of runStats.stats) {
    if (stat.total === 0) continue;
    const log = logger.child({ supermarket: stat.supermarketId, runId: runStats.runId });
    const failureRate = stat.failed / stat.total;
    const dominant = dominantErrorType(stat.errorTypeCounts);
    const dominantCount = dominant ? (stat.errorTypeCounts.get(dominant) ?? 0) : 0;

    // Transient whole-site failure (IP block, CDN blip, timeouts): retry once
    // in ~20 min instead of judging now. The recovery run is evaluated on its
    // own finalize, merged with this run's numbers.
    if (
      failureRate >= RECOVERY_MIN_FAILURE_RATE &&
      shouldAutoRecover({
        failed: stat.failed,
        dominantType: dominant,
        dominantFraction: stat.failed > 0 ? dominantCount / stat.failed : 0,
        isRecoveryRun: runStats.isRecovery,
      })
    ) {
      try {
        const recoveryRunId = await scheduleSupermarketRecovery(
          runStats.runId,
          stat.supermarketId,
        );
        if (recoveryRunId) {
          result.recoveriesScheduled += 1;
          log.warn({ recoveryRunId, dominant }, 'scheduled auto-recovery (evaluation deferred)');
          continue;
        }
      } catch (err) {
        log.error({ err }, 'auto-recovery scheduling failed; evaluating now');
      }
    }

    const baseline = baselines.get(stat.supermarketId) ?? null;
    const verdict = classifyIncident({
      ...stat,
      baselineSuccessRate: baseline,
      afterRecovery: runStats.isRecovery,
    });
    const fingerprint = incidentFingerprint(stat.supermarketId);

    if (!verdict) {
      const note = `${stat.succeeded}/${stat.total} productos con precio (${pct(stat.succeeded / stat.total)}).`;
      if (await resolveIncident(fingerprint, note)) result.incidentsResolved += 1;
      continue;
    }

    const raised = await raiseIncident(buildIncident(stat, verdict, runStats.runId, baseline));
    result.incidentsRaised += 1;
    log.warn({ kind: verdict.kind, outcome: raised.outcome, notified: raised.notified }, 'incident');
  }

  return result;
}

export function incidentFingerprint(supermarketId: string): string {
  return `scrape:${supermarketId}`;
}

function buildIncident(
  stat: SupermarketStat,
  verdict: IncidentVerdict,
  runId: string,
  baseline: number | null,
) {
  const successRate = stat.succeeded / stat.total;
  const errors = topErrorsSummary(stat.errorTypeCounts);
  const triggerCount = verdict.dominantError
    ? (stat.errorTypeCounts.get(verdict.dominantError) ?? 0)
    : 0;

  const title =
    verdict.kind === 'down'
      ? `${stat.supermarketName} caída`
      : verdict.kind === 'blocked'
        ? `${stat.supermarketName}: ${verdict.dominantError} en ${triggerCount} productos`
        : `${stat.supermarketName} trae muchos menos precios que lo habitual`;

  const parts = [
    `${stat.succeeded}/${stat.total} productos con precio (${pct(successRate)}).`,
    baseline !== null ? `Lo habitual: ~${pct(baseline)}.` : null,
    errors ? `Errores: ${errors}.` : null,
    verdict.hint,
    'Detalle y muestras: npm run incidents',
  ];

  return {
    fingerprint: incidentFingerprint(stat.supermarketId),
    severity: verdict.severity,
    type: ALERT_TYPE_BY_KIND[verdict.kind],
    supermarketId: stat.supermarketId,
    title,
    message: parts.filter(Boolean).join(' '),
    context: {
      run_id: runId,
      kind: verdict.kind,
      total: stat.total,
      succeeded: stat.succeeded,
      failed: stat.failed,
    },
    evidence: {
      run_id: runId,
      kind: verdict.kind,
      dominant_error: verdict.dominantError,
      success_rate: round(successRate),
      baseline_success_rate: baseline === null ? null : round(baseline),
      error_counts: Object.fromEntries(stat.errorTypeCounts),
      samples: stat.samples,
      card: `docs/CADENAS.md (${stat.supermarketName})`,
    },
  };
}

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function round(rate: number): number {
  return Math.round(rate * 1000) / 1000;
}

/** Update each chain's `health_status` badge from the run's effective stats. */
export async function updateSupermarketHealth(stats: SupermarketStat[]): Promise<void> {
  for (const stat of stats) {
    if (stat.total === 0) continue;
    const failureRate = stat.failed / stat.total;
    const health: 'healthy' | 'degraded' | 'down' =
      failureRate >= HEALTH_DOWN_FAILURE_RATE
        ? 'down'
        : failureRate >= HEALTH_DEGRADED_FAILURE_RATE
          ? 'degraded'
          : 'healthy';

    const { error } = await db
      .from('supermarkets')
      .update({ health_status: health, last_run_at: new Date().toISOString() })
      .eq('id', stat.supermarketId);
    if (error) {
      logger.error({ err: error, supermarket: stat.supermarketId }, 'failed to update supermarket health');
    }
  }
}
