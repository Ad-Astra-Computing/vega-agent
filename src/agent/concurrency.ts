/**
 * Map over items with a bounded number of concurrent workers, preserving input
 * order in the results. Used to overlap the per-path cache pipeline (compress,
 * upload, attest) instead of running it strictly serially, which dominated push
 * wall-clock for large closures.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await fn(items[i]!, i);
    }
  };
  const workers = Math.min(Math.max(1, Math.floor(limit) || 1), Math.max(1, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}
