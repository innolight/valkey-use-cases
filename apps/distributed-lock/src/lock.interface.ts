/**
 * Result of attempting to acquire a distributed lock
 */
/** Whether the lock was successfully acquired */
export interface AcquireLockResult {
  success: boolean;
  /** Unique lock identifier if successful, undefined otherwise */
  lockId?: string;
  /** Time in milliseconds to wait before retrying if lock acquisition failed */
  retryAfter?: number;
  /** Additional metadata about the lock acquisition (e.g., instances acquired for Redlock) */
  metadata?: Record<string, unknown>;
}

/**
 * Result of attempting to release a distributed lock
 */
export interface ReleaseLockResult {
  /** Whether the lock was successfully released */
  success: boolean;
  /** Additional metadata about the lock release (e.g., instances released for Redlock) */
  metadata?: Record<string, unknown>;
}

/**
 * Interface for distributed lock implementations
 *
 * This interface abstracts different distributed locking strategies:
 * - SimpleMutexLock: Single-instance fail-fast lock
 * - RedLock: Multi-instance consensus-based lock
 * - WatchdogLock: Auto-renewing lock for long operations
 * - etc.
 *
 * All implementations must provide:
 * 1. acquire() - Attempt to acquire a lock for a resource
 * 2. release() - Release a previously acquired lock
 *
 * Implementation Guidelines:
 * - acquire() should be idempotent where possible
 * - release() should verify lock ownership before releasing
 * - Use unique lockId to prevent accidental release by other processes
 * - Handle errors gracefully and provide meaningful error messages
 */
export interface DistributedLock {
  /**
   * Attempts to acquire a distributed lock for the given resource
   *
   * @param resource - The resource identifier to lock (e.g., "user:123", "order:456")
   * @param durationMs - Duration lock is acquired in milliseconds
   * @returns Promise resolving to result indicating success/failure, lock ID, and retry timing
   *
   * @example
   * ```typescript
   * const result = await lock.acquire('user:123', 30000);
   * if (result.success) {
   *   console.log(`Lock acquired with ID: ${result.lockId}`);
   * } else {
   *   console.log(`Lock failed, retry after ${result.retryAfter}ms`);
   * }
   * ```
   */
  acquire(resource: string, durationMs: number): Promise<AcquireLockResult>;

  /**
   * Releases a distributed lock if and only if the caller owns it
   *
   * This method should:
   * - Verify lock ownership using the provided lockId
   * - Only release the lock if the caller is the owner
   * - Return success=false if the lock has expired or is owned by another process
   *
   * @param resource - The resource identifier to unlock
   * @param lockId - The unique lock ID returned from acquire()
   * @returns Promise resolving to result indicating whether the lock was successfully released
   *
   * @example
   * ```typescript
   * const releaseResult = await lock.release('user:123', lockId);
   * if (releaseResult.success) {
   *   console.log('Lock released successfully');
   * } else {
   *   console.log('Lock already expired or owned by another process');
   * }
   * ```
   */
  release(resource: string, lockId: string): Promise<ReleaseLockResult>;
}
