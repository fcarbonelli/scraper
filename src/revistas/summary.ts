/**
 * Revista summary for the Daily Review ("Publicación") screen.
 *
 * Magazine chains have no scrape jobs and write run-less snapshots, so they
 * never appear in a run's coverage/gap list. This gives the review screen a
 * small side panel so the operator still sees, for the day being reviewed:
 *   - how many magazines still need a human (pending review items),
 *   - how many magazine products landed today (freshly approved + carried
 *     forward), broken down per chain.
 *
 * It's purely informational — approving/reviewing magazines happens through the
 * `/v1/revistas/*` endpoints, not the run publish gate.
 */

import { db } from '../shared/db.js';

/** YYYY-MM-DD for a date in Argentina time (the export's business day). */
function buenosAiresDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
  }).format(d);
}

/** BA-day [start, end) as UTC ISO bounds. Argentina is UTC-3 year-round. */
function baDayUtcRange(day: string): { startUtc: string; endUtc: string } {
  const startUtc = new Date(`${day}T03:00:00.000Z`); // BA 00:00 = 03:00 UTC
  const endUtc = new Date(startUtc.getTime() + 24 * 60 * 60 * 1000);
  return { startUtc: startUtc.toISOString(), endUtc: endUtc.toISOString() };
}

export interface RevistaChainSummary {
  supermarket_id: string;
  supermarket_name: string;
  /** Distinct magazine products with a snapshot on this day. */
  products_today: number;
  /** Review items still awaiting a human decision. */
  pending_items: number;
}

export interface RevistaRunSummary {
  /** Magazines with ≥1 pending item — these raise the review banner. */
  pending_magazines: number;
  /** Items approved on this day (fresh magazine prices). */
  approved_today: number;
  /** Prices re-emitted by the daily carry-forward on this day. */
  carried_today: number;
  /** Distinct magazine products present in today's export. */
  products_today: number;
  by_chain: RevistaChainSummary[];
}

const EMPTY: RevistaRunSummary = {
  pending_magazines: 0,
  approved_today: 0,
  carried_today: 0,
  products_today: 0,
  by_chain: [],
};

/**
 * Build the revista side-panel summary for the day a run covers. `runStartedAt`
 * is the run's `started_at` (ISO); we bucket magazine snapshots by that BA day.
 */
export async function revistaRunSummary(runStartedAt: string): Promise<RevistaRunSummary> {
  // 1. Active magazine-sourced chains.
  const { data: sms, error: smErr } = await db
    .from('supermarkets')
    .select('id, name, config')
    .eq('is_active', true);
  if (smErr) throw smErr;
  const chains = (sms ?? []).filter(
    (s) => (s.config as { source_type?: string } | null)?.source_type === 'revista',
  );
  if (chains.length === 0) return EMPTY;
  const chainIds = new Set(chains.map((s) => s.id as string));

  const day = buenosAiresDate(new Date(runStartedAt));
  const { startUtc, endUtc } = baDayUtcRange(day);

  // 2. Active magazine products → which chain they belong to.
  const { data: sps, error: spErr } = await db
    .from('supermarket_products')
    .select('id, supermarket_id')
    .in('supermarket_id', [...chainIds])
    .eq('is_active', true);
  if (spErr) throw spErr;
  const spToChain = new Map<string, string>();
  for (const sp of sps ?? []) spToChain.set(sp.id as string, sp.supermarket_id as string);
  const spIds = [...spToChain.keys()];

  // 3. Snapshots dated within this BA day, classified by their source.
  const perChainProducts = new Map<string, Set<string>>();
  let approved = 0;
  let carried = 0;
  const CHUNK = 200;
  for (let i = 0; i < spIds.length; i += CHUNK) {
    const chunk = spIds.slice(i, i + CHUNK);
    const { data: snaps, error } = await db
      .from('price_snapshots')
      .select('supermarket_product_id, raw_data')
      .in('supermarket_product_id', chunk)
      .gte('scraped_at', startUtc)
      .lt('scraped_at', endUtc);
    if (error) throw error;
    for (const s of snaps ?? []) {
      const spId = s.supermarket_product_id as string;
      const chain = spToChain.get(spId);
      if (!chain) continue;
      const set = perChainProducts.get(chain) ?? new Set<string>();
      set.add(spId);
      perChainProducts.set(chain, set);
      const src = (s.raw_data as { source?: string } | null)?.source;
      if (src === 'revista') approved++;
      else if (src === 'revista-carry-forward') carried++;
    }
  }

  // 4. Pending review items per chain + how many magazines they span.
  const { data: pend, error: pendErr } = await db
    .from('revista_review_items')
    .select('magazine_id, supermarket_id')
    .eq('status', 'pending');
  if (pendErr) throw pendErr;
  const pendingByChain = new Map<string, number>();
  const pendingMagazines = new Set<string>();
  for (const r of pend ?? []) {
    const chain = r.supermarket_id as string;
    if (!chainIds.has(chain)) continue;
    pendingByChain.set(chain, (pendingByChain.get(chain) ?? 0) + 1);
    pendingMagazines.add(r.magazine_id as string);
  }

  const by_chain: RevistaChainSummary[] = chains
    .map((s) => {
      const id = s.id as string;
      return {
        supermarket_id: id,
        supermarket_name: (s.name as string) ?? id,
        products_today: perChainProducts.get(id)?.size ?? 0,
        pending_items: pendingByChain.get(id) ?? 0,
      };
    })
    .filter((c) => c.products_today > 0 || c.pending_items > 0);

  const products_today = [...perChainProducts.values()].reduce((n, set) => n + set.size, 0);

  return {
    pending_magazines: pendingMagazines.size,
    approved_today: approved,
    carried_today: carried,
    products_today,
    by_chain,
  };
}
