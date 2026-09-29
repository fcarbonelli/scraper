/**
 * Which discovery jobs the list endpoint returns.
 *
 * The dashboard asks for the newest 100 (`?status=all&limit=100`) and then
 * keeps `scope === "sweep"`. A week of small EAN jobs would push Sunday's
 * sweep off that page, so completed sweeps from the retention window are
 * pinned and the remaining slots go to everything else, newest first.
 */

export interface ListableJob {
  jobId: string;
  scope: string;
  createdAt: string;
}

/** How long a Sunday sweep must stay visible in the default list. */
export const SWEEP_LIST_RETENTION_MS = 8 * 7 * 24 * 60 * 60 * 1000;

export function selectDiscoveryList<T extends ListableJob>(
  jobs: T[],
  opts: { limit: number; pinSweeps: boolean; nowMs: number },
): T[] {
  const newest = [...jobs].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  if (!opts.pinSweeps) return newest.slice(0, opts.limit);

  const cutoff = opts.nowMs - SWEEP_LIST_RETENTION_MS;
  const sweeps = newest.filter(
    (j) => j.scope === 'sweep' && Date.parse(j.createdAt) >= cutoff,
  );
  const pinned = sweeps.slice(0, opts.limit);
  const pinnedIds = new Set(pinned.map((j) => j.jobId));
  const room = Math.max(0, opts.limit - pinned.length);
  const rest = newest.filter((j) => !pinnedIds.has(j.jobId)).slice(0, room);
  return [...pinned, ...rest].sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
  );
}
