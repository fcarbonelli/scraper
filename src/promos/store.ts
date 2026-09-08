/**
 * Persistence for the promotions module.
 *
 * - Upserts each NormalizedPromotion into `promotions` (canonical, de-duped by
 *   provider + external_id), refreshing fields + last_seen and setting
 *   is_active=true.
 * - Writes a `promotion_snapshots` row ONLY for NEW or CHANGED promotions
 *   (detected via a content hash), so weekly history grows by the delta instead
 *   of ~20k rows every run.
 * - Deactivates promotions that were NOT seen this run (is_active=false) so the
 *   dashboard's "active" view reflects reality, while history is preserved.
 *
 * All DB access goes through the shared service-role client. This module never
 * touches the supermarket price tables.
 */

import { createHash } from 'node:crypto';
import { db } from '../shared/db.js';
import { logger } from '../shared/logger.js';
import type { NormalizedPromotion, ProviderRunSummary } from './types.js';

const UPSERT_CHUNK = 500;

/**
 * Stable SHA-256 over a promotion's MEANINGFUL fields (arrays sorted, no
 * timestamps), so an identical promo hashes the same across runs. Drives
 * snapshot deduplication: we only write history when this hash changes.
 */
function computeHash(p: NormalizedPromotion): string {
  const sorted = (a: string[]): string[] => [...a].sort();
  const canonical = {
    title: p.title,
    issuer: p.issuer,
    merchant: p.merchant,
    category: p.category,
    subcategory: p.subcategory,
    subtitle: p.subtitle,
    paymentMethods: sorted(p.paymentMethods),
    weekdays: sorted(p.weekdays),
    purchaseModes: sorted(p.purchaseModes),
    maxDiscountPct: p.maxDiscountPct,
    maxInstallments: p.maxInstallments,
    validFrom: p.validFrom,
    validTo: p.validTo,
    url: p.url,
    fullUrl: p.fullUrl,
    logoUrl: p.logoUrl,
    imageUrl: p.imageUrl,
    isFeatured: p.isFeatured,
    plans: p.plans,
    tags: p.tags,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** Map a NormalizedPromotion onto the `promotions` table row shape. */
function toRow(p: NormalizedPromotion, contentHash: string): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    provider_id: p.providerId,
    external_id: p.externalId,
    title: p.title,
    issuer: p.issuer,
    merchant: p.merchant,
    category: p.category,
    category_name: p.categoryName,
    subcategory: p.subcategory,
    subtitle: p.subtitle,
    payment_methods: p.paymentMethods,
    weekdays: p.weekdays,
    purchase_modes: p.purchaseModes,
    max_discount_pct: p.maxDiscountPct,
    max_installments: p.maxInstallments,
    valid_from: p.validFrom,
    valid_to: p.validTo,
    url: p.url,
    full_url: p.fullUrl,
    logo_url: p.logoUrl,
    image_url: p.imageUrl,
    is_featured: p.isFeatured,
    is_active: true,
    plans: p.plans,
    tags: p.tags,
    raw: p.raw,
    content_hash: contentHash,
    last_seen: now,
    updated_at: now,
  };
}

/**
 * Persist one provider's promotions for a run: upsert, snapshot, deactivate
 * stale. Returns a summary for logging.
 */
export async function persistProviderPromotions(
  providerId: string,
  promos: NormalizedPromotion[],
  runId: string,
): Promise<ProviderRunSummary> {
  const log = logger.child({ provider: providerId, phase: 'promos-store' });

  // 1. Prior content hashes (per external_id). Missing = new promo; different =
  //    changed. Both get a fresh snapshot; unchanged promos do NOT (dedup).
  const priorHash = await loadPriorHashes(providerId);

  // 2. Upsert in chunks; collect returned ids for snapshots. We refresh the
  //    canonical row every run (bumps last_seen, fixed-size table); only the
  //    history table is deduped.
  const idByExternal = new Map<string, string>();
  const hashByExternal = new Map<string, string>();
  for (let i = 0; i < promos.length; i += UPSERT_CHUNK) {
    const chunk = promos.slice(i, i + UPSERT_CHUNK);
    const rows = chunk.map((p) => {
      const hash = computeHash(p);
      hashByExternal.set(p.externalId, hash);
      return toRow(p, hash);
    });
    const { data, error } = await db
      .from('promotions')
      .upsert(rows, { onConflict: 'provider_id,external_id' })
      .select('id, external_id');
    if (error) throw error;
    for (const r of data ?? []) {
      idByExternal.set(r.external_id as string, r.id as string);
    }
  }

  // 3. Snapshot ONLY new/changed promotions (weekly history, deduped).
  const snapshots = promos
    .filter((p) => priorHash.get(p.externalId) !== hashByExternal.get(p.externalId))
    .map((p) => {
      const promotionId = idByExternal.get(p.externalId);
      if (!promotionId) return null;
      return {
        promotion_id: promotionId,
        provider_id: providerId,
        run_id: runId,
        payload: p,
      };
    })
    .filter((s): s is NonNullable<typeof s> => s !== null);

  for (let i = 0; i < snapshots.length; i += UPSERT_CHUNK) {
    const chunk = snapshots.slice(i, i + UPSERT_CHUNK);
    const { error } = await db.from('promotion_snapshots').insert(chunk);
    if (error) throw error;
  }

  // 4. Deactivate promotions not seen this run.
  const seen = new Set(promos.map((p) => p.externalId));
  const deactivated = await deactivateMissing(providerId, seen);

  const created = promos.filter((p) => !priorHash.has(p.externalId)).length;
  const summary: ProviderRunSummary = {
    providerId,
    fetched: promos.length,
    upserted: idByExternal.size,
    created,
    snapshotted: snapshots.length,
    unchanged: promos.length - snapshots.length,
    deactivated,
  };
  log.info(summary, 'promos persisted');
  return summary;
}

/**
 * Prior content hashes keyed by external_id (any is_active state). A missing
 * entry means the promo is new; a differing hash means it changed.
 */
async function loadPriorHashes(providerId: string): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('promotions')
      .select('external_id, content_hash')
      .eq('provider_id', providerId)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const batch = data ?? [];
    for (const r of batch) {
      out.set(r.external_id as string, (r.content_hash as string | null) ?? null);
    }
    if (batch.length < PAGE) break;
  }
  return out;
}

/**
 * Mark active promotions whose external_id was NOT seen this run as inactive.
 * We compute the diff client-side and update by id in chunks (avoids a giant
 * `not.in` filter blowing past PostgREST's URL length limit).
 */
async function deactivateMissing(
  providerId: string,
  seen: Set<string>,
): Promise<number> {
  const PAGE = 1000;
  const staleIds: string[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('promotions')
      .select('id, external_id')
      .eq('provider_id', providerId)
      .eq('is_active', true)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const batch = data ?? [];
    for (const r of batch) {
      if (!seen.has(r.external_id as string)) staleIds.push(r.id as string);
    }
    if (batch.length < PAGE) break;
  }

  const CHUNK = 200;
  for (let i = 0; i < staleIds.length; i += CHUNK) {
    const chunk = staleIds.slice(i, i + CHUNK);
    const { error } = await db
      .from('promotions')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .in('id', chunk);
    if (error) throw error;
  }
  return staleIds.length;
}

/** Update promo_providers.last_run_at after a successful provider run. */
export async function markProviderRun(providerId: string): Promise<void> {
  const { error } = await db
    .from('promo_providers')
    .update({ last_run_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', providerId);
  if (error) throw error;
}
