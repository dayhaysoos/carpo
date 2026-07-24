export async function settleWithConcurrency<T>(
  items: T[],
  task: (item: T) => Promise<unknown>,
  concurrency = 4,
): Promise<PromiseSettledResult<void>[]> {
  const results = new Array<PromiseSettledResult<void>>(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        try {
          await task(items[index]);
          results[index] = { status: "fulfilled", value: undefined };
        } catch (reason) {
          results[index] = { status: "rejected", reason };
        }
      }
    },
  );
  await Promise.all(workers);
  return results;
}
