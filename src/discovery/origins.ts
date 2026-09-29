/**
 * Where a supermarket_products row came from, for the weekly "altas" rollup.
 *
 * New rows are stamped in `metadata.source`. Older rows are not, so we fall
 * back to the synthetic external_id prefixes (`instore-`, `revista-`) and,
 * for plain URL mappings, to whether the chain can be searched by EAN:
 * a chain without search cannot have been added by the sweep.
 */

export type MappingOrigin = 'scrape' | 'manual_url' | 'instore' | 'revista';

const EMPTY: Record<MappingOrigin, number> = {
  scrape: 0,
  manual_url: 0,
  instore: 0,
  revista: 0,
};

export function emptyOriginCounts(): Record<MappingOrigin, number> {
  return { ...EMPTY };
}

export function classifyMappingOrigin(row: {
  externalId: string;
  metadata: unknown;
  hasSearch: boolean;
}): MappingOrigin {
  const meta =
    row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, unknown>)
      : {};
  const source = typeof meta.source === 'string' ? meta.source : null;

  if (source === 'instore' || row.externalId.startsWith('instore-')) return 'instore';
  if (source === 'revista' || row.externalId.startsWith('revista-')) return 'revista';
  if (source === 'discover' || source === 'sweep') return 'scrape';
  if (source === 'manual_url') return 'manual_url';
  // Unstamped URL mapping. Searchable chains were filled by discovery;
  // chains without search only grow when someone pastes a URL.
  return row.hasSearch ? 'scrape' : 'manual_url';
}
