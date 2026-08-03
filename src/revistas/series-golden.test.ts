/**
 * Golden test: every label currently stored in `revista_magazines`, run through
 * the live `deriveSeriesKey` AND through a copy of the pre-change rule.
 *
 * The question this answers is narrow on purpose: did dropping Vital's branch
 * suffix move anything other than Vital's branch-suffixed rows? Comparing
 * against the *stored* key would answer a different (and misleading) question —
 * many stored keys come from migration 015's SQL backfill and already disagree
 * with what the TypeScript derives today (`jul2mm.pdf` is stored `mm`, derives
 * `jul2mm-pdf`; `Ofertas especiales…` is stored `prov`, derives `sponsor`).
 * That drift predates this change, and the re-key script must not "fix" it —
 * see `scripts/revistas-rekey-series.ts`, which only touches rows where the
 * legacy and current rules disagree.
 *
 * Fixture regenerated from prod; see docs/REVISTAS_PLAN.md.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { deriveSeriesKey, legacySeriesKeyFromVitalDataName } from './series.js';

interface Row {
  supermarket_id: string;
  label: string;
  series_key: string | null;
  source_strategy: string;
}

const rows: Row[] = JSON.parse(
  readFileSync(new URL('../../examples/revistas/series-labels.json', import.meta.url), 'utf8'),
);

/**
 * Reconstruct which argument carried the label, mirroring `toPdfLink`
 * (download.ts): Vital anchors supply `data-name`, Makro anchors a `title`, and
 * anything else falls back to the filename. pubhtml5/publuu never reach here.
 */
function deriveFromRow(row: Row): string {
  if (row.source_strategy !== 'html-pdf-links') {
    return deriveSeriesKey({ label: row.label, strategy: row.source_strategy as 'pubhtml5' });
  }
  const isDataName = row.label.includes('|') || /\([^)]*\)\s*$/.test(row.label);
  if (isDataName) {
    return deriveSeriesKey({ dataName: row.label, label: row.label, strategy: 'html-pdf-links' });
  }
  const isFilename = row.label.toLowerCase().endsWith('.pdf');
  return deriveSeriesKey({
    ...(isFilename ? { filename: row.label } : { title: row.label }),
    label: row.label,
    strategy: 'html-pdf-links',
  });
}

/**
 * The pre-change rule, verbatim: slugify(stripDateNoise(dataName)) with the
 * branch suffix left in. Only the Vital data-name branch changed, so every
 * other path can defer to the live implementation.
 */
function legacyFromRow(row: Row): string {
  if (row.source_strategy !== 'html-pdf-links') return deriveFromRow(row);
  const isDataName = row.label.includes('|') || /\([^)]*\)\s*$/.test(row.label);
  if (!isDataName) return deriveFromRow(row);
  return legacySeriesKeyFromVitalDataName(row.label);
}

/** The complete set of key moves this change is allowed to make. */
const EXPECTED_MOVES: Record<string, string> = {
  'aviso-fds-resto': 'aviso-fds',
  'aviso-marca-propia-todas': 'aviso-marca-propia',
  'aviso-ninez-todas': 'aviso-ninez',
  'aviso-panales-todas': 'aviso-panales',
  'aviso-solo-jueves-resto': 'aviso-solo-jueves',
  'aviso-solo-lunes-resto': 'aviso-solo-lunes',
  'especial-frescos-todas': 'especial-frescos',
  'folder-malvinas-abasto': 'folder',
  'folder-nonfood-amba-menos-lp': 'folder-nonfood',
  'folder-nonfood-resto': 'folder-nonfood',
  'folder-resto': 'folder',
};

describe('deriveSeriesKey — golden set over real stored labels', () => {
  it('has a non-trivial fixture', () => {
    expect(rows.length).toBeGreaterThan(40);
  });

  it('moves nothing outside Vital', () => {
    const moved = rows
      .filter((r) => r.supermarket_id !== 'vital')
      .filter((r) => deriveFromRow(r) !== legacyFromRow(r))
      .map((r) => `${r.supermarket_id} "${r.label}": ${legacyFromRow(r)} → ${deriveFromRow(r)}`);
    expect(moved).toEqual([]);
  });

  it('moves Vital keys only in the documented way', () => {
    for (const row of rows.filter((r) => r.supermarket_id === 'vital')) {
      const before = legacyFromRow(row);
      const after = deriveFromRow(row);
      const expected = EXPECTED_MOVES[before] ?? before;
      expect(after, `label="${row.label}"`).toBe(expected);
    }
  });

  it('collapses the branch rotation that broke supersede', () => {
    const folder = rows.filter((r) => /^Folder \d/.test(r.label) && r.label.includes('|'));
    expect(folder.length).toBeGreaterThan(1);
    expect([...new Set(folder.map(deriveFromRow))]).toEqual(['folder']);
    expect([...new Set(folder.map(legacyFromRow))].sort()).toEqual([
      'folder-malvinas-abasto',
      'folder-resto',
    ]);
  });

  it('keeps concurrent Vital flyer lines apart', () => {
    const nonfood = rows.filter((r) => r.label.startsWith('Folder Nonfood'));
    expect([...new Set(nonfood.map(deriveFromRow))]).toEqual(['folder-nonfood']);
  });
});
