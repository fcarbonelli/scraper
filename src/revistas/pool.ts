/**
 * Run `fn` over `items` with bounded concurrency, PRESERVING input order in the
 * result (results[i] corresponds to items[i]). Order stability matters because
 * review-item ordering (per page) must be deterministic across runs.
 */
export async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const workers = Math.max(1, Math.min(limit, items.length || 1));
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      const item = items[i] as T;
      results[i] = await fn(item, i);
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}
