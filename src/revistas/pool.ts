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

/**
 * Reject with a timeout error if `p` doesn't settle within `ms`. Used to stop a
 * hung magazine discovery (e.g. a stalled Playwright/network call) from wedging
 * the whole daily revista check — and, in turn, blocking the carry-forward step
 * that runs after it.
 *
 * Note: this races the promise; it does not cancel the underlying work (the
 * caller's error path just moves on). The dangling work is harmless.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
