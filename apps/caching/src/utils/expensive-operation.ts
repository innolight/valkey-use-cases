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
