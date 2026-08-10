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
  type VisitLocation,
} from './entry.js';

/** One reviewer decision for a pending entry (edits optional). */
export interface ReviewDecision {
  entryId: string;
  action: 'approve' | 'reject';
  /** Inline edits applied before approval. Omit to keep the entered value. */
  price?: number;
  wholesalePrice?: number | null;
  wholesaleMinUnits?: number | null;
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
  price: number;
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

  const entriesRes = await db
    .from('instore_price_entries')
    .select('id, ean, price, promo_price, promo_min_units, note, api_key_id')
    .eq('visit_id', visitId)
    .eq('review_status', 'pending');
  if (entriesRes.error) throw entriesRes.error;
  const entries = (entriesRes.data ?? []) as PendingEntryRow[];

  const byId = new Map((input.decisions ?? []).map((d) => [d.entryId, d]));
  const nowIso = new Date().toISOString();
  const result: ApproveVisitResult = { visitId, approved: 0, rejected: 0, snapshots: 0 };

  for (const entry of entries) {
    const decision = byId.get(entry.id);

    if (decision?.action === 'reject') {
      const upd = await db
        .from('instore_price_entries')
        .update({
          review_status: 'rejected',
          reviewed_at: nowIso,
          reviewed_by: input.reviewedBy,
          note: decision.note !== undefined ? decision.note : entry.note,
        })
        .eq('id', entry.id);
      if (upd.error) throw upd.error;
      result.rejected++;
      continue;
    }

    // Approve — apply any inline edits, else keep the entered values.
    const price = decision?.price ?? entry.price;
    const wholesalePrice =
      decision && decision.wholesalePrice !== undefined ? decision.wholesalePrice : entry.promo_price;
    const wholesaleMinUnits =
      decision && decision.wholesaleMinUnits !== undefined
        ? decision.wholesaleMinUnits
        : entry.promo_min_units;
    const note = decision && decision.note !== undefined ? decision.note : entry.note;

    const mat = await materializeInStoreEntry({
      supermarketId: visit.supermarket_id,
      ean: entry.ean,
      price,
      wholesalePrice,
      wholesaleMinUnits,
      enteredBy: visit.entered_by,
      note,
      visitId,
      location,
      apiKeyId: entry.api_key_id,
    });

    const upd = await db
      .from('instore_price_entries')
      .update({
        price,
        promo_price: wholesalePrice,
        promo_min_units: wholesaleMinUnits,
        promo_text: wholesalePromoText(wholesalePrice, wholesaleMinUnits),
        note,
        resulting_supermarket_product_id: mat.supermarketProductId,
        resulting_snapshot_id: mat.snapshotId,
        review_status: 'approved',
        reviewed_at: nowIso,
        reviewed_by: input.reviewedBy,
      })
      .eq('id', entry.id);
    if (upd.error) throw upd.error;

    result.approved++;
    result.snapshots++;
  }

  const visitUpd = await db
    .from('instore_visits')
    .update({ review_status: 'approved', reviewed_at: nowIso, reviewed_by: input.reviewedBy })
    .eq('id', visitId);
  if (visitUpd.error) throw visitUpd.error;

  logger.info(result, 'instore: visit reviewed & approved');
  return result;
}
