/**
 * Price-anomaly detection + suppression.
 *
 * Some sites return a garbage low price for a product that's really out of stock
 * (notably VTEX/Cencosud — a $158 "2 L lavandina" next to $13 000 peers). When
 * the site exposes an availability flag, `src/worker/persist.ts` already maps
 * `inStock === false` to an `out_of_stock` marker. This module is the SAFETY NET
 * for the residual case: a bogus low price the site reports as *available*, with
 * no OOS flag to key off. It detects statistical outliers and (optionally)
 * suppresses them so the client never sees the fake price.
 *
 * Detection (per candidate 'ok' priced snapshot):
 *   0. EDP-TARGET (primary, peer-independent): the client's target price
 *      (price_targets) for the EAN + channel. If the scraped price is a tiny
 *      fraction of the target (default < 25%), it's bogus regardless of peers.
 *      This is the ONLY rule that catches "uniform sentinels" — where every
 *      store shares the same bad value (Vea+Disco+Jumbo all $158.77) so the
 *      cross-store median is itself bogus.
 *   1. CROSS-STORE (fallback): the same EAN priced at other stores TODAY, within
 *      the SAME channel family (supermarket vs. mayorista). Channel-scoping the
 *      median is deliberate — wholesale prices are structurally lower than
 *      retail, so mixing them would falsely flag a legit wholesale price.
 *   2. SELF-HISTORY (fallback): the mapping's own recent median (last N days).
 *      Catches single-store products with no same-channel peers today.
 *
 * A row is flagged when its price undercuts the baseline by more than the
 * threshold (median default: price < 35% of baseline — a 65%+ collapse; target
 * default: price < 25% of the EDP target). Real promos live in the OFFER fields
 * (Precio_Regular is the LIST price), so a collapsed regular price is almost
 * always a data error, not a sale.
 *
 * Suppression rewrites the snapshot to an `out_of_stock` marker (no price),
 * exactly like the persist-layer OOS path, and stashes the original value +
 * detection metadata under `raw_data.priceSuspect` for audit. Only SCRAPED
 * snapshots (scrape_run_id set) are ever touched — trusted in-store/manual
 * run-less entries are never auto-suppressed.
 *
 * Side-effecting: touches the DB. The pure `detectAnomalies` is exported
 * separately for reuse/testing.
 */

import { db, fetchAllPages } from './db.js';

/** Tunables for anomaly detection. */
export interface AnomalyOptions {
  /** Flag when price < threshold * median baseline (0.35 ⇒ flag a 65%+ collapse). */
  threshold: number;
  /** Flag when price < targetThreshold * EDP target (0.25 ⇒ flag < 25% of target). */
  targetThreshold: number;
  /** Minimum baseline sample size (peers or history points) before judging. */
  minPeers: number;
  /** How many days of self-history to consider for the secondary baseline. */
  historyDays: number;
}

export const DEFAULT_ANOMALY_OPTIONS: AnomalyOptions = {
  threshold: 0.35,
  targetThreshold: 0.25,
  minPeers: 2,
  historyDays: 30,
};

// -----------------------------------------------------------------------------
// Row shapes
// -----------------------------------------------------------------------------

interface SpJoin {
  supermarket_id: string;
  products:
    | { ean: string | null; name: string | null }
    | { ean: string | null; name: string | null }[]
    | null;
}
interface SnapRow {
  id: string;
  supermarket_product_id: string;
  scraped_at: string;
  price: number | null;
  status: string;
  scrape_run_id: string | null;
  supermarket_products: SpJoin | SpJoin[] | null;
}

/** A candidate snapshot considered for anomaly detection. */
export interface AnomalyItem {
  snapshotId: string;
  mappingId: string;
  store: string;
  /** Full channel string (e.g. "SPM NACIONAL", "MAY REGIONAL"). */
  canal: string;
  /** Channel family: 'SPM' | 'MAY' | other — scopes the cross-store median. */
  canalFamily: string;
  ean: string;
  name: string;
  price: number;
}

/** A detected outlier, with the baseline it failed against. */
export interface AnomalyFlag extends AnomalyItem {
  baseline: number;
  ratio: number;
  source: 'target' | 'cross-store' | 'self-history';
  peers: number;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function median(nums: number[]): number {
  if (nums.length === 0) return NaN;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function firstJoin<T>(v: T | T[] | null | undefined): T | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

/** Collapse a full canal string ("SPM NACIONAL") to its family ("SPM"). */
export function canalFamily(canal: string | null | undefined): string {
  const c = (canal ?? '').trim().toUpperCase();
  if (c.startsWith('SPM')) return 'SPM';
  if (c.startsWith('MAY')) return 'MAY';
  return c || 'OTHER';
}

/**
 * Map a supermarket's channel to the price_targets `canal` code that holds its
 * EDP target — mirrors the client_base view's join logic (migrations 012→023):
 *   SPM*          → 'SPM'
 *   MAY REGIONAL  → 'MAY REG'
 *   MAY* (other)  → 'MAY'
 * Returns null for channels with no target concept (e.g. unknown).
 */
export function targetCanalFor(canal: string | null | undefined): string | null {
  const c = (canal ?? '').trim().toUpperCase();
  if (c.startsWith('SPM')) return 'SPM';
  if (c === 'MAY REGIONAL') return 'MAY REG';
  if (c.startsWith('MAY')) return 'MAY';
  return null;
}

/** The most recent calendar date (UTC) that has any snapshot. */
async function latestSnapshotDate(): Promise<string> {
  const { data, error } = await db
    .from('price_snapshots')
    .select('scraped_at')
    .order('scraped_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return String(data?.scraped_at ?? new Date().toISOString()).slice(0, 10);
}

/** The (UTC) calendar date of a run's earliest snapshot, or null if it has none. */
async function runSnapshotDate(runId: string): Promise<string | null> {
  const { data, error } = await db
    .from('price_snapshots')
    .select('scraped_at')
    .eq('scrape_run_id', runId)
    .order('scraped_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data?.scraped_at ? String(data.scraped_at).slice(0, 10) : null;
}

// -----------------------------------------------------------------------------
// Loaders
// -----------------------------------------------------------------------------

/**
 * Load the day's SCRAPED, `ok`, positively-priced snapshots as candidate items.
 * Run-less snapshots (in-store/manual/carry-forward, scrape_run_id NULL) are
 * excluded — those are trusted and never auto-suppressed. EAN-less rows are
 * skipped (the client keys on EAN and they're not exported anyway).
 */
async function loadDayItems(date: string): Promise<AnomalyItem[]> {
  const dayStart = `${date}T00:00:00.000Z`;
  const dayEnd = `${date}T23:59:59.999Z`;

  const rows = await fetchAllPages<SnapRow>((from, to) =>
    db
      .from('price_snapshots')
      .select(
        'id, supermarket_product_id, scraped_at, price, status, scrape_run_id, supermarket_products:supermarket_product_id ( supermarket_id, products:product_id ( ean, name ) )',
      )
      .gte('scraped_at', dayStart)
      .lte('scraped_at', dayEnd)
      .eq('status', 'ok')
      .gt('price', 0)
      .not('scrape_run_id', 'is', null)
      .order('id', { ascending: true })
      .range(from, to),
  );

  // canal per supermarket (small table).
  const { data: sms, error: smErr } = await db.from('supermarkets').select('id, canal');
  if (smErr) throw smErr;
  const canalByStore = new Map<string, string>(
    (sms ?? []).map((s) => [s.id as string, ((s.canal as string | null) ?? '').trim()]),
  );

  const items: AnomalyItem[] = [];
  for (const r of rows) {
    const sp = firstJoin(r.supermarket_products);
    if (!sp || r.price == null) continue;
    const prod = firstJoin(sp.products);
    const ean = prod?.ean ?? '';
    if (!ean) continue;
    const canal = canalByStore.get(sp.supermarket_id) ?? '';
    items.push({
      snapshotId: r.id,
      mappingId: r.supermarket_product_id,
      store: sp.supermarket_id,
      canal,
      canalFamily: canalFamily(canal),
      ean,
      name: prod?.name ?? '',
      price: r.price,
    });
  }
  return items;
}

/**
 * EDP targets keyed by `${ean}|${targetCanal}` (targetCanal ∈ SPM|MAY|MAY REG).
 * Mirrors the price_targets rows the client_base view joins on.
 */
async function loadTargets(): Promise<Map<string, number>> {
  const rows = await fetchAllPages<{ ean: string | null; canal: string | null; edp: number | null }>(
    (from, to) => db.from('price_targets').select('ean, canal, edp').order('ean', { ascending: true }).range(from, to),
  );
  const map = new Map<string, number>();
  for (const r of rows) {
    if (!r.ean || !r.canal || r.edp == null || r.edp <= 0) continue;
    map.set(`${r.ean}|${r.canal.trim().toUpperCase()}`, r.edp);
  }
  return map;
}

/** Per-mapping price history (last `historyDays`, excluding the target day). */
async function loadHistory(
  date: string,
  historyDays: number,
): Promise<Map<string, number[]>> {
  const dayStart = `${date}T00:00:00.000Z`;
  const histStart = new Date(new Date(dayStart).getTime() - historyDays * 86_400_000).toISOString();

  const rows = await fetchAllPages<{ supermarket_product_id: string; price: number | null }>((from, to) =>
    db
      .from('price_snapshots')
      .select('supermarket_product_id, price')
      .gte('scraped_at', histStart)
      .lt('scraped_at', dayStart)
      .eq('status', 'ok')
      .gt('price', 0)
      .order('id', { ascending: true })
      .range(from, to),
  );

  const byMapping = new Map<string, number[]>();
  for (const h of rows) {
    if (h.price == null) continue;
    const arr = byMapping.get(h.supermarket_product_id) ?? [];
    arr.push(h.price);
    byMapping.set(h.supermarket_product_id, arr);
  }
  return byMapping;
}

// -----------------------------------------------------------------------------
// Detection (pure)
// -----------------------------------------------------------------------------

/**
 * Flag price outliers among `items`. Rules, in priority order:
 *   0. EDP target (peer-independent): price < targetThreshold * target.
 *   1. Cross-store median, scoped to the same (ean, channel-family).
 *   2. Per-mapping self-history median.
 * The first rule with enough signal wins; if none has signal, the row is left.
 */
export function detectAnomalies(
  items: AnomalyItem[],
  histByMapping: Map<string, number[]>,
  targetsByEanCanal: Map<string, number> = new Map(),
  options: AnomalyOptions = DEFAULT_ANOMALY_OPTIONS,
): AnomalyFlag[] {
  // Group today's prices by (ean, channel-family) for the cross-store median.
  const byEanFamily = new Map<string, AnomalyItem[]>();
  const key = (ean: string, fam: string): string => `${ean}|${fam}`;
  for (const it of items) {
    const k = key(it.ean, it.canalFamily);
    const arr = byEanFamily.get(k) ?? [];
    arr.push(it);
    byEanFamily.set(k, arr);
  }

  const flags: AnomalyFlag[] = [];
  for (const it of items) {
    // Rule 0 — EDP target (strongest, peer-independent). Catches uniform
    // sentinels where every store shares the same bogus value.
    const targetCanal = targetCanalFor(it.canal);
    const target = targetCanal ? targetsByEanCanal.get(`${it.ean}|${targetCanal}`) : undefined;
    if (target && target > 0) {
      const ratio = it.price / target;
      if (ratio < options.targetThreshold) {
        flags.push({ ...it, baseline: target, ratio, source: 'target', peers: 0 });
        continue;
      }
    }

    // Rules 1/2 — median baselines (cross-store then self-history).
    const peers = (byEanFamily.get(key(it.ean, it.canalFamily)) ?? [])
      .filter((p) => p.snapshotId !== it.snapshotId)
      .map((p) => p.price);
    const hist = histByMapping.get(it.mappingId) ?? [];

    let baseline = NaN;
    let source: AnomalyFlag['source'] = 'cross-store';
    let peerCount = 0;
    if (peers.length >= options.minPeers) {
      baseline = median(peers);
      peerCount = peers.length;
      source = 'cross-store';
    } else if (hist.length >= options.minPeers) {
      baseline = median(hist);
      peerCount = hist.length;
      source = 'self-history';
    } else {
      continue; // not enough signal to judge
    }

    if (!Number.isFinite(baseline) || baseline <= 0) continue;
    const ratio = it.price / baseline;
    if (ratio < options.threshold) {
      flags.push({ ...it, baseline, ratio, source, peers: peerCount });
    }
  }

  flags.sort((a, b) => a.ratio - b.ratio);
  return flags;
}

// -----------------------------------------------------------------------------
// Suppression (mutating)
// -----------------------------------------------------------------------------

/**
 * Rewrite each flagged snapshot to an `out_of_stock` marker (no price) and stash
 * the original value + detection metadata under `raw_data.priceSuspect`. Merges
 * into existing raw_data per row (small N, so per-row is fine).
 */
export async function suppressSnapshots(flags: AnomalyFlag[]): Promise<void> {
  if (flags.length === 0) return;

  const ids = flags.map((f) => f.snapshotId);
  const { data: existing, error: readErr } = await db
    .from('price_snapshots')
    .select('id, raw_data')
    .in('id', ids);
  if (readErr) throw readErr;
  const rawById = new Map<string, Record<string, unknown>>(
    (existing ?? []).map((r) => [r.id as string, (r.raw_data as Record<string, unknown>) ?? {}]),
  );

  const detectedAt = new Date().toISOString();
  for (const f of flags) {
    const raw = { ...(rawById.get(f.snapshotId) ?? {}) };
    raw['priceSuspect'] = {
      original: f.price,
      baseline: Number(f.baseline.toFixed(2)),
      ratio: Number(f.ratio.toFixed(4)),
      source: f.source,
      peers: f.peers,
      detectedAt,
    };
    const { error } = await db
      .from('price_snapshots')
      .update({
        status: 'out_of_stock',
        price: null,
        list_price: null,
        unit_price: null,
        unit_price_per: null,
        offer_price_1: null,
        offer_price_2: null,
        promotion_1: null,
        promotion_2: null,
        unit_discount: null,
        promotions: [],
        in_stock: false,
        raw_data: raw,
      })
      .eq('id', f.snapshotId);
    if (error) throw error;
  }
}

// -----------------------------------------------------------------------------
// Orchestration
// -----------------------------------------------------------------------------

export interface RunAnomalyArgs {
  /** Scan a specific calendar date (UTC, YYYY-MM-DD). */
  date?: string;
  /** Scan the day of a specific run (used by the finalizer). */
  runId?: string;
  /** When true, detect only — don't mutate. */
  dryRun?: boolean;
  options?: Partial<AnomalyOptions>;
}

/**
 * Detect (and unless `dryRun`, suppress) anomalous low prices for a day.
 * Resolves the date from `date`, else the run's snapshots, else the latest
 * snapshot day. Returns the flags (whether or not they were suppressed).
 * Idempotent: suppressed rows drop out of the `ok` candidate set on re-run.
 */
export async function runAnomalySuppression(args: RunAnomalyArgs = {}): Promise<AnomalyFlag[]> {
  const options: AnomalyOptions = { ...DEFAULT_ANOMALY_OPTIONS, ...(args.options ?? {}) };

  let date = args.date;
  if (!date && args.runId) date = (await runSnapshotDate(args.runId)) ?? undefined;
  if (!date) date = await latestSnapshotDate();

  const [items, hist, targets] = await Promise.all([
    loadDayItems(date),
    loadHistory(date, options.historyDays),
    loadTargets(),
  ]);
  const flags = detectAnomalies(items, hist, targets, options);

  if (!args.dryRun) await suppressSnapshots(flags);
  return flags;
}
