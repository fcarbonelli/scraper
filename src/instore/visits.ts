/**
 * PDV visit ("relevamiento") lifecycle.
 *
 * A visit is one worker at one store branch on one occasion. It carries the
 * branch location (address / locality / province — a chain has many branches),
 * groups the product entries and flyer photos captured while there, and has an
 * explicit finish step so the worker saves the relevamiento and leaves the PDV
 * to start another.
 */

import { db } from '../shared/db.js';
import { logger } from '../shared/logger.js';
import { assertInStoreSupermarket, InStoreError } from './entry.js';

export interface CreateVisitInput {
  supermarketId: string;
  provincia?: string | null;
  localidad?: string | null;
  direccion?: string | null;
  enteredBy: string;
  note?: string | null;
  apiKeyId?: string | null;
}

export interface VisitCounts {
  entries: number;
  photos: number;
}

export interface Visit {
  id: string;
  supermarketId: string;
  provincia: string | null;
  localidad: string | null;
  direccion: string | null;
  enteredBy: string;
  note: string | null;
  status: 'open' | 'finished';
  startedAt: string;
  finishedAt: string | null;
}

interface VisitRow {
  id: string;
  supermarket_id: string;
  provincia: string | null;
  localidad: string | null;
  direccion: string | null;
  entered_by: string;
  note: string | null;
  status: 'open' | 'finished';
  started_at: string;
  finished_at: string | null;
}

function toVisit(r: VisitRow): Visit {
  return {
    id: r.id,
    supermarketId: r.supermarket_id,
    provincia: r.provincia,
    localidad: r.localidad,
    direccion: r.direccion,
    enteredBy: r.entered_by,
    note: r.note,
    status: r.status,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

const VISIT_COLS =
  'id, supermarket_id, provincia, localidad, direccion, entered_by, note, status, started_at, finished_at';

/** Start a relevamiento at a PDV. Validates the chain is in-store-enabled. */
export async function createVisit(input: CreateVisitInput): Promise<Visit> {
  await assertInStoreSupermarket(input.supermarketId);

  const { data, error } = await db
    .from('instore_visits')
    .insert({
      supermarket_id: input.supermarketId,
      provincia: input.provincia ?? null,
      localidad: input.localidad ?? null,
      direccion: input.direccion ?? null,
      entered_by: input.enteredBy,
      note: input.note ?? null,
      status: 'open',
      api_key_id: input.apiKeyId ?? null,
    })
    .select(VISIT_COLS)
    .single();
  if (error) throw error;

  logger.info({ visitId: data.id, supermarketId: input.supermarketId, enteredBy: input.enteredBy }, 'instore: visit started');
  return toVisit(data as VisitRow);
}

/** Count the entries + photos recorded during a visit. */
export async function countVisit(visitId: string): Promise<VisitCounts> {
  const [entries, photos] = await Promise.all([
    db.from('instore_price_entries').select('id', { count: 'exact', head: true }).eq('visit_id', visitId),
    db.from('instore_photos').select('id', { count: 'exact', head: true }).eq('visit_id', visitId),
  ]);
  if (entries.error) throw entries.error;
  if (photos.error) throw photos.error;
  return { entries: entries.count ?? 0, photos: photos.count ?? 0 };
}

/** Load one visit (or null). */
export async function getVisit(visitId: string): Promise<Visit | null> {
  const { data, error } = await db.from('instore_visits').select(VISIT_COLS).eq('id', visitId).maybeSingle();
  if (error) throw error;
  return data ? toVisit(data as VisitRow) : null;
}

/**
 * Finish a visit: save the relevamiento and mark it closed so the worker leaves
 * this PDV. Idempotent — finishing an already-finished visit just returns it.
 */
export async function finishVisit(visitId: string): Promise<{ visit: Visit; counts: VisitCounts }> {
  const current = await getVisit(visitId);
  if (!current) throw new InStoreError('not_found', 'Visit not found');

  let visit = current;
  if (current.status !== 'finished') {
    const { data, error } = await db
      .from('instore_visits')
      .update({ status: 'finished', finished_at: new Date().toISOString() })
      .eq('id', visitId)
      .select(VISIT_COLS)
      .single();
    if (error) throw error;
    visit = toVisit(data as VisitRow);
    logger.info({ visitId }, 'instore: visit finished');
  }

  const counts = await countVisit(visitId);
  return { visit, counts };
}
