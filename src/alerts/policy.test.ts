/**
 * Unit tests for the incident policy (no DB). The cases mirror real
 * production days: chronic product_not_found chains must stay quiet.
 */

import { describe, it, expect } from 'vitest';
import { baselineSuccessRate, classifyIncident, NOT_RUN } from './policy.js';

function input(
  total: number,
  succeeded: number,
  errors: Record<string, number>,
  baselineSuccessRate: number | null = null,
) {
  return {
    total,
    succeeded,
    failed: total - succeeded,
    errorTypeCounts: new Map(Object.entries(errors)),
    baselineSuccessRate,
  };
}

describe('classifyIncident', () => {
  it('stays quiet for a chain that is chronically ~60% product_not_found', () => {
    // mercadolibre on 2026-11-07: 43 not found out of ~65, normal for it.
    expect(classifyIncident(input(65, 22, { product_not_found: 43 }, 0.36))).toBeNull();
  });

  it('stays quiet for maxi-carrefour at its usual ~20% success', () => {
    expect(classifyIncident(input(52, 11, { product_not_found: 41 }, 0.21))).toBeNull();
  });

  it('flags a chain where almost nothing came back as down', () => {
    const v = classifyIncident(input(100, 3, { rate_limited: 90, network_timeout: 7 }));
    expect(v?.kind).toBe('down');
    expect(v?.severity).toBe('critical');
    expect(v?.dominantError).toBe('rate_limited');
  });

  it('flags an expired session even when most products still scraped', () => {
    const v = classifyIncident(input(40, 28, { auth_required: 12 }, 0.95));
    expect(v?.kind).toBe('blocked');
    expect(v?.dominantError).toBe('auth_required');
  });

  it('ignores a handful of auth errors mixed into chronic not-found noise', () => {
    expect(
      classifyIncident(input(65, 21, { product_not_found: 41, auth_required: 3 }, 0.35)),
    ).toBeNull();
  });

  it('flags jobs that never ran (dead worker) as blocked', () => {
    const v = classifyIncident(input(30, 18, { [NOT_RUN]: 12 }, 0.9));
    expect(v?.kind).toBe('blocked');
    expect(v?.dominantError).toBe(NOT_RUN);
  });

  it('treats transient errors as noise on the first pass', () => {
    expect(classifyIncident(input(192, 120, { network_timeout: 72 }, 0.88))).toBeNull();
  });

  it('flags transient errors that survived the recovery retry', () => {
    // la-anonima 2026-11-03: 72 products still timing out after the retry.
    const v = classifyIncident({
      ...input(192, 120, { network_timeout: 72 }, 0.88),
      afterRecovery: true,
    });
    expect(v?.kind).toBe('blocked');
    expect(v?.dominantError).toBe('network_timeout');
  });

  it('flags a sharp drop against the chain’s own baseline', () => {
    const v = classifyIncident(input(100, 40, { product_not_found: 60 }, 0.95));
    expect(v?.kind).toBe('drop');
    expect(v?.severity).toBe('warning');
  });

  it('does not flag a drop without a baseline', () => {
    expect(classifyIncident(input(100, 40, { product_not_found: 60 }, null))).toBeNull();
  });

  it('never alerts on fewer than 3 failures', () => {
    expect(classifyIncident(input(2, 0, { selector_failed: 2 }))).toBeNull();
  });
});

describe('baselineSuccessRate', () => {
  it('needs at least 3 runs', () => {
    expect(baselineSuccessRate([0.9, 0.8])).toBeNull();
  });

  it('takes the median of the 7 most recent runs', () => {
    expect(baselineSuccessRate([0.1, 0.9, 0.8, 0.85, 0.95, 0.9, 0.88, 0.0])).toBe(0.88);
  });

  it('averages the middle pair for an even count', () => {
    expect(baselineSuccessRate([0.5, 0.7, 0.9, 1])).toBe(0.8);
  });
});
