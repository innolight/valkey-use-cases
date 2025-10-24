/**
 * Simulates an expensive operation (database query, API call, etc.)
 * Used for demonstrating cache performance improvements
 */
export async function simulateExpensiveOperation(
  key: string,
  delayMs = 1000,
): Promise<{ data: string; computedAt: string }> {
  // Simulate I/O delay
  await new Promise((resolve) => setTimeout(resolve, delayMs));

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
  delayMs = 1000,
): Promise<void> {
  // Simulate I/O delay (database write, API call, etc.)
  await new Promise((resolve) => setTimeout(resolve, delayMs));

  // In a real implementation, this would write to a database
  console.log(`[DB Write] Key: ${key}, Value:`, value);
}
