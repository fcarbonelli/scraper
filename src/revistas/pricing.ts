/**
 * Pure revista pricing / dedup helpers (no DB imports).
 *
 * Used by approve/edit/carry-forward, unit tests, and the offline simulator
 * so the "one row per mapping/day" + "offer wins" rules can be validated
 * without Supabase or Docker.
 */

/** YYYY-MM-DD for a date in Argentina time (the business day the export uses). */
export function buenosAiresDate(d: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
  }).format(d);
}

/**
 * Last N Buenos Aires calendar days as YYYY-MM-DD, including today.
 * e.g. n=3 on 2026-07-21 → {"2026-07-19","2026-07-20","2026-07-21"}.
 */
export function lastBaDays(n: number, now: Date = new Date()): Set<string> {
  const today = buenosAiresDate(now);
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const out = new Set<string>();
  const count = Math.max(1, Math.floor(n));
  for (let i = 0; i < count; i++) {
    // Calendar arithmetic in UTC so month boundaries stay correct.
    const dt = new Date(Date.UTC(y, m - 1, d - i));
    out.add(dt.toISOString().slice(0, 10));
  }
  return out;
}

export interface SnapshotPrices {
  /** Regular price the reviewer confirms off the image. */
  price: number | null;
  /** Sale/offer price, if any. */
  promoPrice: number | null;
  /** Promo text (e.g. "2x1", "2do al 50%"). */
  promoText: string | null;
}

/** Columns we write onto `price_snapshots` for a revista approval/edit. */
export interface MappedSnapshotColumns {
  price: number;
  list_price: number | null;
  promotion_1: string | null;
  offer_price_1: number | null;
  promotions: Array<{ type: string; description: string }>;
}

/**
 * Map reviewer/AI prices onto the platform snapshot convention:
 *   price       = selling price (promo when present)
 *   list_price  = crossed-out regular when it's a genuine markdown
 *   promotion_1 / offer_price_1 = promo text + promo amount
 */
export function mapSnapshotPrices(prices: SnapshotPrices): MappedSnapshotColumns {
  const hasPromo = prices.promoPrice != null && prices.promoPrice > 0;
  const regular = prices.price ?? prices.promoPrice ?? null;
  const selling = hasPromo ? (prices.promoPrice as number) : regular;
  if (selling == null) {
    throw new Error('Cannot write a snapshot without a price or promo price.');
  }
  const listPrice = hasPromo && regular != null && regular > selling ? regular : null;
  const promoText = prices.promoText?.trim() ? prices.promoText.trim() : null;

  return {
    price: selling,
    list_price: listPrice,
    promotion_1: promoText,
    offer_price_1: hasPromo ? (prices.promoPrice as number) : null,
    promotions: promoText ? [{ type: 'unknown', description: promoText }] : [],
  };
}

/** Effective prices returned by the list/review UI (override beats extracted). */
export function effectivePrices(
  extracted: SnapshotPrices | null | undefined,
  override: Partial<SnapshotPrices> | null | undefined,
): SnapshotPrices {
  return {
    price: override?.price !== undefined ? override.price : (extracted?.price ?? null),
    promoPrice:
      override?.promoPrice !== undefined ? override.promoPrice : (extracted?.promoPrice ?? null),
    promoText:
      override?.promoText !== undefined ? override.promoText : (extracted?.promoText ?? null),
  };
}

export type TodayWriteAction = 'insert' | 'update';

/**
 * Decide whether today's run-less snapshot for a mapping should be inserted
 * or updated in-place. Never insert a second row for the same BA day.
 */
export function decideTodayWrite(
  existingTodaySnapshotId: number | null | undefined,
): TodayWriteAction {
  return existingTodaySnapshotId != null ? 'update' : 'insert';
}

/** A candidate row when collapsing same-mapping / same-day duplicates. */
export interface DedupCandidate {
  id: number | string;
  /** Selling / regular price shown in the export. */
  price: number | null;
  /** Promo text (e.g. "OFERTA"). Non-empty ⇒ has offer. */
  promotion_1: string | null;
  offer_price_1: number | null;
  /** ISO timestamp — newer wins on ties. */
  scraped_at: string;
}

function hasOffer(c: DedupCandidate): boolean {
  if (c.offer_price_1 != null && c.offer_price_1 > 0) return true;
  return Boolean(c.promotion_1 && c.promotion_1.trim());
}

/**
 * Among duplicate real rows (same mapping / same day), keep ONE:
 * offer wins; ties → most recent scraped_at.
 */
export function pickWinnerAmongDuplicates<T extends DedupCandidate>(rows: T[]): T | null {
  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0] ?? null;

  return [...rows].sort((a, b) => {
    const ao = hasOffer(a) ? 1 : 0;
    const bo = hasOffer(b) ? 1 : 0;
    if (ao !== bo) return bo - ao;
    return b.scraped_at.localeCompare(a.scraped_at);
  })[0] ?? null;
}

/** Rows that should be deleted after picking a winner. */
export function losersAmongDuplicates<T extends DedupCandidate>(rows: T[]): T[] {
  const winner = pickWinnerAmongDuplicates(rows);
  if (!winner) return [];
  return rows.filter((r) => r.id !== winner.id);
}

/** Input row for EAN-collision detection (family B — do NOT auto-delete). */
export interface EanCollisionRow {
  ean: string;
  supermarket_id: string;
  /** Buenos Aires calendar day YYYY-MM-DD. */
  day: string;
  product_id: string;
  /** Optional display helpers for reports. */
  name?: string | null;
  snapshot_id?: number | string;
}

export interface EanCollisionGroup {
  ean: string;
  supermarket_id: string;
  day: string;
  product_ids: string[];
  rows: EanCollisionRow[];
}

/**
 * Detect family-B collisions: same EAN + same chain + same day, but DISTINCT
 * product_ids. These are mis-assigned EANs — never auto-delete; surface for
 * human rematch / EAN correction.
 */
export function findEanCollisions(rows: EanCollisionRow[]): EanCollisionGroup[] {
  const byKey = new Map<string, EanCollisionRow[]>();
  for (const r of rows) {
    const ean = r.ean.replace(/\D/g, '');
    if (!ean) continue;
    const key = `${ean}|${r.supermarket_id}|${r.day}`;
    const list = byKey.get(key) ?? [];
    list.push({ ...r, ean });
    byKey.set(key, list);
  }

  const out: EanCollisionGroup[] = [];
  for (const [, group] of byKey) {
    const productIds = [...new Set(group.map((g) => g.product_id))];
    if (productIds.length < 2) continue;
    const first = group[0];
    if (!first) continue;
    out.push({
      ean: first.ean,
      supermarket_id: first.supermarket_id,
      day: first.day,
      product_ids: productIds,
      rows: group,
    });
  }
  return out;
}

/** raw_data.source values that identify revista-owned snapshots. */
export const REVISTA_SNAPSHOT_SOURCES = ['revista', 'revista-carry-forward'] as const;
export type RevistaSnapshotSource = (typeof REVISTA_SNAPSHOT_SOURCES)[number];

export function isRevistaSnapshotSource(source: string | null | undefined): boolean {
  return source === 'revista' || source === 'revista-carry-forward';
}
