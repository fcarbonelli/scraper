/**
 * In-store daily review (per PDV visit).
 *
 * Field submissions are logged as PENDING entries (see entry.ts). A back-office
 * operator reviews a finished visit and approves it: each approved entry is
 * materialized into a run-less snapshot (that's when it reaches the client
 * base), with inline edits allowed; rejected entries are discarded.
 *
 * This mirrors the revista review pattern (approve-then-materialize), so the
 * client_base export needs no gating logic and only approved prices ever reach
 * it. Each approved entry publishes on its approval day only (no carry-forward).
 */

import { db } from '../shared/db.js';
import { logger } from '../shared/logger.js';
import {
  InStoreError,
  materializeInStoreEntry,
  wholesalePromoText,
  type MaterializeResult,
  type VisitLocation,
} from './entry.js';
import { ensureMasterProductForEan } from './resolve.js';

/** One reviewer decision for a pending entry (edits optional). */
export interface ReviewDecision {
  entryId: string;
  action: 'approve' | 'reject';
  /** Inline edits applied before approval. Omit to keep the entered value. */
  price?: number;
  wholesalePrice?: number | null;
  wholesaleMinUnits?: number | null;
  /** Flip the entry to/from "sin precio" during review. */
  noPrice?: boolean;
  note?: string | null;
}

export interface ApproveVisitInput {
  reviewedBy: string;
  /**
   * Per-entry decisions. Any pending entry NOT listed defaults to approve with
   * its entered values — so an empty list means "approve everything as-is".
   */
  decisions?: ReviewDecision[];
}

export interface ApproveVisitResult {
  visitId: string;
  approved: number;
  rejected: number;
  snapshots: number;
}

interface VisitRow {
  id: string;
  supermarket_id: string;
  provincia: string | null;
  localidad: string | null;
  direccion: string | null;
  entered_by: string;
  status: 'open' | 'finished';
  review_status: string;
}

interface PendingEntryRow {
  id: string;
  ean: string;
  price: number | null;
  no_price: boolean;
  promo_price: number | null;
  promo_min_units: number | null;
  note: string | null;
  api_key_id: string | null;
}

/**
 * Approve a finished visit: materialize each approved (optionally edited) entry
 * into a live snapshot and reject the rest. Marks the visit reviewed.
 */
export async function approveVisit(
  visitId: string,
  input: ApproveVisitInput,
): Promise<ApproveVisitResult> {
  const visitRes = await db
    .from('instore_visits')
    .select('id, supermarket_id, provincia, localidad, direccion, entered_by, status, review_status')
    .eq('id', visitId)
    .maybeSingle();
  if (visitRes.error) throw visitRes.error;
  const visit = visitRes.data as VisitRow | null;
  if (!visit) throw new InStoreError('not_found', 'Visit not found');
  if (visit.status !== 'finished') {
    throw new InStoreError('invalid', 'Finish the visit before approving it');
  }

  const location: VisitLocation = {
    provincia: visit.provincia,
    localidad: visit.localidad,
    direccion: visit.direccion,
  };

  // created_at order makes "last wins" deterministic for duplicate EANs (Fix 4).
  const entriesRes = await db
    .from('instore_price_entries')
    .select('id, ean, price, no_price, promo_price, promo_min_units, note, api_key_id')
    .eq('visit_id', visitId)
    .eq('review_status', 'pending')
    .order('created_at', { ascending: true });
  if (entriesRes.error) throw entriesRes.error;
  const entries = (entriesRes.data ?? []) as PendingEntryRow[];

  const byId = new Map((input.decisions ?? []).map((d) => [d.entryId, d]));
  const nowIso = new Date().toISOString();
  const result: ApproveVisitResult = { visitId, approved: 0, rejected: 0, snapshots: 0 };

  // ---------------------------------------------------------------------------
  // Phase 1 — build the plan (NO DB writes). All validation happens here, before
  // anything is mutated, so a bad input can't leave the visit half-approved.
  // ---------------------------------------------------------------------------
  interface ApprovePlan {
    entry: PendingEntryRow;
    ean: string;
    price: number | null;
    wholesalePrice: number | null;
    wholesaleMinUnits: number | null;
    noPrice: boolean;
    note: string | null;
  }
  const toReject: { entry: PendingEntryRow; note: string | null }[] = [];
  const toApprove: ApprovePlan[] = [];

  for (const entry of entries) {
    const decision = byId.get(entry.id);

    if (decision?.action === 'reject') {
      toReject.push({ entry, note: decision.note !== undefined ? decision.note : entry.note });
      continue;
    }

    // Apply inline edits, else keep the entered values. Resolve no_price:
    // explicit flag wins; else a provided price implies a real price; else keep.
    const note = decision && decision.note !== undefined ? decision.note : entry.note;
    const noPrice =
      decision?.noPrice !== undefined
        ? decision.noPrice
        : decision?.price !== undefined
          ? false
          : entry.no_price;

    let price: number | null;
    let wholesalePrice: number | null;
    let wholesaleMinUnits: number | null;
    if (noPrice) {
      price = null;
      wholesalePrice = null;
      wholesaleMinUnits = null;
    } else {
      price = decision?.price ?? entry.price;
      if (price == null || price <= 0) {
        throw new InStoreError(
          'invalid',
          `Entry ${entry.id} has no price — set a price or mark it no_price`,
        );
      }
      wholesalePrice =
        decision && decision.wholesalePrice !== undefined ? decision.wholesalePrice : entry.promo_price;
      wholesaleMinUnits =
        decision && decision.wholesaleMinUnits !== undefined
          ? decision.wholesaleMinUnits
          : entry.promo_min_units;
    }

    toApprove.push({ entry, ean: entry.ean, price, wholesalePrice, wholesaleMinUnits, noPrice, note });
  }

  // ---------------------------------------------------------------------------
  // Phase 2 — collapse duplicate EANs within the visit (Fix 4). Only ONE snapshot
  // per EAN is published; the winner is deterministic: a real price beats a
  // no_price marker, and among the same kind the LAST (most recent) entry wins.
  // Loser entries are still marked approved and linked to the winner's snapshot.
  // ---------------------------------------------------------------------------
  const winnerIdxByEan = new Map<string, number>();
  toApprove.forEach((p, i) => {
    const prevIdx = winnerIdxByEan.get(p.ean);
    if (prevIdx === undefined) {
      winnerIdxByEan.set(p.ean, i);
      return;
    }
    const prev = toApprove[prevIdx]!;
    if (!p.noPrice && prev.noPrice) {
      winnerIdxByEan.set(p.ean, i); // real price beats an existing marker
    } else if (p.noPrice === prev.noPrice) {
      winnerIdxByEan.set(p.ean, i); // same kind → later entry wins
    }
    // else: prev is a real price and p is a marker → keep prev
  });

  // ---------------------------------------------------------------------------
  // Phase 3 — resolve/create the master product for every winning EAN BEFORE any
  // write (Fix 3). An EAN no longer in the catalog throws here, so the approval
  // aborts with zero snapshots/entries mutated.
  // ---------------------------------------------------------------------------
  const productIdByEan = new Map<string, string>();
  for (const [ean] of winnerIdxByEan) {
    const pid = await ensureMasterProductForEan(ean);
    if (!pid) throw new InStoreError('not_found', `EAN ${ean} is not in the catalog`);
    productIdByEan.set(ean, pid);
  }

  // ---------------------------------------------------------------------------
  // Phase 4 — writes. supabase-js has no client-side transaction, so this is not
  // a single atomic commit; instead all failure-prone work (validation + product
  // resolution) already ran above, and every write here is idempotent + driven
  // off review_status='pending'. So a transient mid-loop failure leaves the visit
  // still 'pending' and re-running approve safely resumes.
  // ---------------------------------------------------------------------------
  for (const r of toReject) {
    const upd = await db
      .from('instore_price_entries')
      .update({
        review_status: 'rejected',
        reviewed_at: nowIso,
        reviewed_by: input.reviewedBy,
        note: r.note,
      })
      .eq('id', r.entry.id);
    if (upd.error) throw upd.error;
    result.rejected++;
  }

  // Materialize exactly one snapshot per winning EAN (conflict-aware; see
  // materializeInStoreEntry).
  const matByEan = new Map<string, MaterializeResult>();
  for (const [ean, idx] of winnerIdxByEan) {
    const p = toApprove[idx]!;
    const mat = await materializeInStoreEntry({
      supermarketId: visit.supermarket_id,
      ean,
      productId: productIdByEan.get(ean),
      price: p.price,
      wholesalePrice: p.wholesalePrice,
      wholesaleMinUnits: p.wholesaleMinUnits,
      noPrice: p.noPrice,
      enteredBy: visit.entered_by,
      note: p.note,
      visitId,
      location,
      apiKeyId: p.entry.api_key_id,
    });
    matByEan.set(ean, mat);
    result.snapshots++;
  }

  // Mark every approved entry (winners + deduped losers) approved, each linked to
  // its EAN's published snapshot.
  for (const p of toApprove) {
    const mat = matByEan.get(p.ean)!;
    const upd = await db
      .from('instore_price_entries')
      .update({
        price: p.price,
        no_price: p.noPrice,
        promo_price: p.wholesalePrice,
        promo_min_units: p.wholesaleMinUnits,
        promo_text: wholesalePromoText(p.wholesalePrice, p.wholesaleMinUnits),
        note: p.note,
        resulting_supermarket_product_id: mat.supermarketProductId,
        resulting_snapshot_id: mat.snapshotId,
        review_status: 'approved',
        reviewed_at: nowIso,
        reviewed_by: input.reviewedBy,
      })
      .eq('id', p.entry.id);
    if (upd.error) throw upd.error;
    result.approved++;
  }

  const visitUpd = await db
    .from('instore_visits')
    .update({ review_status: 'approved', reviewed_at: nowIso, reviewed_by: input.reviewedBy })
    .eq('id', visitId);
  if (visitUpd.error) throw visitUpd.error;

  logger.info(result, 'instore: visit reviewed & approved');
  return result;
}
