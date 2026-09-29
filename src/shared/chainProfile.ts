/**
 * Per-chain profile the dashboard reads from GET /v1/supermarkets.
 *
 * One supermarket row is the chain. Online scrape, in-store relevamiento and
 * revistas are channels on that same id — the UI must not join three lists
 * that can disagree on the id.
 */

import type { AdapterCapabilities } from '../adapters/registry.js';

export type ChainChannel = 'online' | 'presencial' | 'revistas';

interface ChainConfig {
  source_type?: unknown;
  instore?: { enabled?: unknown };
  revista?: unknown;
}

function asConfig(config: unknown): ChainConfig {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return {};
  return config as ChainConfig;
}

/**
 * Channels this chain actually participates in.
 *
 * - `online` — a web adapter scrapes it (revista-only / instore-only rows
 *   have no adapter).
 * - `presencial` — the in-store tool is enabled (`config.instore.enabled`,
 *   or `source_type: "instore"`).
 * - `revistas` — magazine pipeline (`source_type: "revista"` or a `revista`
 *   config block).
 */
export function channelsForChain(hasAdapter: boolean, config: unknown): ChainChannel[] {
  const cfg = asConfig(config);
  const source = typeof cfg.source_type === 'string' ? cfg.source_type : null;
  const channels: ChainChannel[] = [];
  if (hasAdapter) channels.push('online');
  if (cfg.instore?.enabled === true || source === 'instore') channels.push('presencial');
  if (source === 'revista' || (cfg.revista != null && typeof cfg.revista === 'object')) {
    channels.push('revistas');
  }
  return channels;
}

/** Snake_case fields added to each supermarket in the list/detail responses. */
export function chainProfileFields(
  config: unknown,
  caps: AdapterCapabilities,
): {
  channels: ChainChannel[];
  has_search: boolean;
  search_provider: string | null;
} {
  return {
    channels: channelsForChain(caps.hasAdapter, config),
    has_search: caps.hasSearch,
    search_provider: caps.searchProvider,
  };
}
