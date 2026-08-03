/**
 * The pre-spend decisions: would the pipeline process this, and is it a new
 * edition or the same file re-exported?
 *
 * The re-upload cases are the real production measurements from 2026-07-30,
 * frozen in examples/revistas/reupload-cases.json — the live case is gone, so a
 * test that probed vital.com.ar could never reproduce it.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  classifyReupload,
  shouldProcessSeries,
  sizeDeltaPct,
  wouldProcess,
  type ExistingMagazine,
} from './decide.js';
import { parseFlyerPeriod } from './period.js';

const DETECTED = new Date('2026-08-03T13:00:00Z');
const OLD_DETECTED = new Date('2026-07-27T13:00:00Z');

interface Fixture {
  cases: {
    file: string;
    label: string;
    storedSize: number;
    freshSize: number;
    expect: string;
  }[];
  newEditions: {
    label: string;
    againstStoredLabel: string;
    storedSize: number;
    freshSize: number;
    expect: string;
  }[];
}

const fixture: Fixture = JSON.parse(
  readFileSync(new URL('../../examples/revistas/reupload-cases.json', import.meta.url), 'utf8'),
);

describe('wouldProcess — the single predicate the pipeline and the button share', () => {
  const states: ExistingMagazine['status'][] = ['processing', 'failed', 'in_review', 'reviewed'];

  it('processes a candidate with no stored row', () => {
    expect(wouldProcess(null, false)).toBe(true);
    expect(wouldProcess(null, true)).toBe(true);
  });

  it('retries crashed and failed rows without --force', () => {
    expect(wouldProcess({ status: 'processing' }, false)).toBe(true);
    expect(wouldProcess({ status: 'failed' }, false)).toBe(true);
  });

  it('skips settled rows without --force', () => {
    expect(wouldProcess({ status: 'in_review' }, false)).toBe(false);
    expect(wouldProcess({ status: 'reviewed' }, false)).toBe(false);
  });

  it('processes every state under --force', () => {
    for (const status of states) {
      expect(wouldProcess({ status }, true), status).toBe(true);
    }
  });

  it('defaults force to false', () => {
    expect(wouldProcess({ status: 'reviewed' })).toBe(false);
  });
});

describe('shouldProcessSeries', () => {
  it('allows anything when no filter is set', () => {
    expect(shouldProcessSeries('folder')).toBe(true);
  });

  it('honours the config skip list', () => {
    expect(shouldProcessSeries('gt', ['gt'])).toBe(false);
    expect(shouldProcessSeries('mm', ['gt'])).toBe(true);
  });

  it('merges the CLI skip list with the config one', () => {
    expect(shouldProcessSeries('mm', ['gt'], { skipSeries: ['mm'] })).toBe(false);
  });

  it('lets onlySeries override every skip list', () => {
    expect(shouldProcessSeries('gt', ['gt'], { onlySeries: ['gt'] })).toBe(true);
    expect(shouldProcessSeries('mm', [], { onlySeries: ['gt'] })).toBe(false);
  });
});

describe('sizeDeltaPct', () => {
  it('is zero for identical sizes', () => {
    expect(sizeDeltaPct(1000, 1000)).toBe(0);
  });

  it('is null when either side is unknown', () => {
    expect(sizeDeltaPct(1000, null)).toBeNull();
    expect(sizeDeltaPct(null, 1000)).toBeNull();
    expect(sizeDeltaPct(0, 1000)).toBeNull();
  });
});

describe('classifyReupload — the real Vital churn of 2026-07-30', () => {
  for (const c of fixture.cases) {
    it(`flags ${c.file} as a re-export`, () => {
      const verdict = classifyReupload({
        strategy: 'html-pdf-links',
        candidate: {
          label: c.label,
          period: parseFlyerPeriod(c.label, OLD_DETECTED),
          fileSize: c.freshSize,
        },
        current: {
          label: c.label,
          period: parseFlyerPeriod(c.label, OLD_DETECTED),
          fileSize: c.storedSize,
        },
      });
      expect(verdict.reupload).toBe(true);
      expect(verdict.sizeDeltaPct).toBeLessThan(0.5);
    });
  }
});

describe('classifyReupload — real new editions must never be skipped', () => {
  for (const c of fixture.newEditions) {
    it(`lets "${c.label}" through`, () => {
      const verdict = classifyReupload({
        strategy: 'html-pdf-links',
        candidate: {
          label: c.label,
          period: parseFlyerPeriod(c.label, DETECTED),
          fileSize: c.freshSize,
        },
        current: {
          label: c.againstStoredLabel,
          period: parseFlyerPeriod(c.againstStoredLabel, OLD_DETECTED),
          fileSize: c.storedSize,
        },
      });
      expect(verdict.reupload).toBe(false);
      expect(verdict.reason).toContain('period differs');
    });
  }
});

describe('classifyReupload — guard rails', () => {
  const period = parseFlyerPeriod('Folder 27.07 al 02.08 | RESTO', OLD_DETECTED);
  const same = { label: 'Folder 27.07 al 02.08 | RESTO', period, fileSize: 1_000_000 };

  it('never fires for pubhtml5, whose label can be a constant fallback', () => {
    // Rosental stores one issue as the literal "PubHTML5 flipbook"; matching on
    // that would skip a real 144-page quincena.
    const verdict = classifyReupload({
      strategy: 'pubhtml5',
      candidate: { label: 'PubHTML5 flipbook', period: null, fileSize: 1_000_000 },
      current: { label: 'PubHTML5 flipbook', period: null, fileSize: 1_000_100 },
    });
    expect(verdict.reupload).toBe(false);
    expect(verdict.reason).toContain('not html-pdf-links');
  });

  it('never fires for publuu, which has no size signal', () => {
    const verdict = classifyReupload({
      strategy: 'publuu',
      candidate: { label: 'Comodín revista', period: null },
      current: { label: 'Comodín revista', period: null },
    });
    expect(verdict.reupload).toBe(false);
  });

  it('never fires when the series has no current issue', () => {
    const verdict = classifyReupload({
      strategy: 'html-pdf-links',
      candidate: same,
      current: null,
    });
    expect(verdict.reupload).toBe(false);
  });

  it('defers to the operator when the size moved beyond the tolerance', () => {
    const verdict = classifyReupload({
      strategy: 'html-pdf-links',
      candidate: same,
      current: { ...same, fileSize: 1_200_000 },
    });
    expect(verdict.reupload).toBe(false);
    expect(verdict.reason).toContain('operator decides');
  });

  it('defers to the operator when there is no size to compare', () => {
    const verdict = classifyReupload({
      strategy: 'html-pdf-links',
      candidate: { ...same, fileSize: null },
      current: { ...same, fileSize: null },
    });
    expect(verdict.reupload).toBe(false);
  });

  it('does not treat an inferred period as authoritative', () => {
    // Two different Rosental-style fortnights would compare "equal enough" on a
    // guessed period; the label has to disagree for that to matter.
    const a = parseFlyerPeriod('Agosto primera quincena', DETECTED);
    expect(a?.confidence).toBe('inferred');
    const verdict = classifyReupload({
      strategy: 'html-pdf-links',
      candidate: { label: 'Agosto primera quincena', period: a, fileSize: 1_000_000 },
      current: { label: 'Julio segunda quincena', period: a, fileSize: 1_000_100 },
    });
    expect(verdict.reupload).toBe(false);
    expect(verdict.reason).toContain('label differs');
  });
});
