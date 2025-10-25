/**
 * Simulates an expensive operation (database query, API call, etc.)
 * Used for demonstrating cache performance improvements
 */
export async function simulateExpensiveOperation(
  key: string,
  delayMs = 1000
): Promise<{ data: string; computedAt: string }> {
  // Simulate I/O delay
  await new Promise(resolve => setTimeout(resolve, delayMs));

  // Return mock data
  return {
    data: `Data for ${key}`,
    computedAt: new Date().toISOString(),
  };
}

/**
 * Simulates an expensive write operation to database/source
 * Used for demonstrating write patterns
 */
export async function simulateExpensiveWrite(
  key: string,
  value: any,
  delayMs = 1000
): Promise<void> {
  // Simulate I/O delay (database write, API call, etc.)
  await new Promise(resolve => setTimeout(resolve, delayMs));

  // In a real implementation, this would write to a database
  console.log(`[DB Write] Key: ${key}, Value:`, value);
}

/**
 * Simulate loading multiple keys in batch
 * Maintains order of input keys in output
 *
 * This is useful for cache warming where you want to load many keys
 * concurrently from the data source (database, API, etc.)
 *
 * @param keys - Array of keys to load
 * @param delayMs - Simulated delay per operation (default: 1000ms)
 * @returns Array of results with key and data pairs
 */
export async function simulateExpensiveOperationBatch(
  keys: string[],
  delayMs = 1000
): Promise<Array<{ key: string; data: any }>> {
  // Process all keys in parallel, maintaining order
  const results = await Promise.all(
    keys.map(async key => ({
      key,
      data: await simulateExpensiveOperation(key, delayMs),
    }))
  );
  return results;
}

/**
 * Split array into chunks for controlled concurrency
 *
 * This helper is essential for batch processing with concurrency limits.
 * Instead of processing all items in parallel (which could overwhelm systems),
 * we process them in controlled batches.
 *
 * Example:
 * ```typescript
 * const keys = ['a', 'b', 'c', 'd', 'e'];
 * const chunks = chunkArray(keys, 2);
 * // Result: [['a', 'b'], ['c', 'd'], ['e']]
 *
 * // Process chunks sequentially, items within chunk in parallel
 * for (const chunk of chunks) {
 *   await Promise.all(chunk.map(key => processKey(key)));
 * }
 * ```
 *
 * @param array - Array to split into chunks
 * @param chunkSize - Maximum size of each chunk
 * @returns Array of chunks
 */
export function chunkArray<T>(array: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}
