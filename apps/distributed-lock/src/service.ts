import { SimpleMutexLock } from './simple-mutex-lock';

/**
 * Result of attempting a mutually exclusive operation
 */
export interface OperationResult {
  /** Whether the operation completed successfully */
  success: boolean;
  /** Resource identifier that was processed */
  resourceId: string;
  /** Duration of the operation in milliseconds (if successful) */
  durationMs?: number;
  /** Time in milliseconds to wait before retrying (if locked) */
  retryAfterMs?: number;
  /** Error message if operation failed */
  error?: string;
}

/**
 * Service for performing mutually exclusive operations using distributed locks
 *
 * This service encapsulates the business logic of:
 * 1. Acquiring a distributed lock for a resource
 * 2. Performing a long-running operation
 * 3. Releasing the lock when done
 * 4. Handling errors and ensuring cleanup
 */
export class OperationService {
  private readonly lockService: SimpleMutexLock;
  private readonly operationMinDurationMs: number;
  private readonly operationMaxDurationMs: number;
  private readonly lockTtlMs: number;

  constructor(options: {
    lockService: SimpleMutexLock;
    operationMinDurationMs?: number;
    operationMaxDurationMs?: number;
    lockTtlMs?: number;
  }) {
    this.lockService = options.lockService;
    // Default: 30-60 second operation (variable duration)
    this.operationMinDurationMs = options.operationMinDurationMs || 10000;
    this.operationMaxDurationMs = options.operationMaxDurationMs || 20000;
    // Default: 20 second TTL with watchdog renewal
    this.lockTtlMs = options.lockTtlMs || 25000;
  }

  /**
   * Performs a mutually exclusive operation on a resource
   *
   * This method:
   * 1. Attempts to acquire a distributed lock for the resource
   * 2. If successful, executes the operation (simulated long-running task)
   * 3. Releases the lock when done
   * 4. Returns appropriate result based on success/failure/contention
   */
  async doMutuallyExclusiveOperation(
    resourceId: string
  ): Promise<OperationResult> {
    try {
      // Attempt to acquire the lock
      const acquireResult = await this.lockService.acquire(
        resourceId,
        this.lockTtlMs
      );

      if (!acquireResult.success) {
        // Lock is held by another process
        console.log(
          `[distributed-lock] Resource "${resourceId}" is locked, retry after ${acquireResult.retryAfter}ms`
        );
        return {
          success: false,
          resourceId,
          retryAfterMs: acquireResult.retryAfter,
          error: 'Resource is currently locked',
        };
      }

      const lockId = acquireResult.lockId!;
      console.log(
        `[distributed-lock] Lock acquired for resource "${resourceId}" with lockId ${lockId}`
      );

      try {
        // Perform the actual operation with variable duration
        const actualDurationMs = await this.performOperation(resourceId);
        console.log(
          `[distributed-lock] Operation completed for resource "${resourceId}" in ${actualDurationMs}ms`
        );

        // Release the lock after successful operation
        const releaseResult = await this.lockService.release(
          resourceId,
          lockId
        );

        if (releaseResult.success) {
          console.log(
            `[distributed-lock] Lock released for resource "${resourceId}"`
          );
        } else {
          console.warn(
            `[distributed-lock] Failed to release lock for resource "${resourceId}" - it may have expired`
          );
        }

        return {
          success: true,
          resourceId,
          durationMs: actualDurationMs,
        };
      } catch (operationError) {
        // Operation failed - try to release the lock anyway
        console.error(
          `[distributed-lock] Operation failed for resource "${resourceId}":`,
          operationError
        );

        try {
          await this.lockService.release(resourceId, lockId);
          console.log(
            `[distributed-lock] Lock released after operation failure for resource "${resourceId}"`
          );
        } catch (releaseError) {
          console.error(
            `[distributed-lock] Failed to release lock after operation error for resource "${resourceId}":`,
            releaseError
          );
        }

        return {
          success: false,
          resourceId,
          error: 'Operation failed during execution',
        };
      }
    } catch (lockError) {
      // Lock acquisition or management failed
      console.error(
        `[distributed-lock] Lock management error for resource "${resourceId}":`,
        lockError
      );
      return {
        success: false,
        resourceId,
        error: 'Failed to acquire or manage lock',
      };
    }
  }

  /**
   * Performs the actual operation on the resource
   * In a real application, this would contain the business logic
   * (e.g., database updates, file processing, external API calls)
   *
   * Simulates a variable-duration operation (30-60 seconds)
   *
   * @param resourceId - The resource being processed
   * @returns The actual duration of the operation in milliseconds
   */
  private async performOperation(resourceId: string): Promise<number> {
    // Generate random duration between min and max
    const durationMs =
      this.operationMinDurationMs +
      Math.random() *
        (this.operationMaxDurationMs - this.operationMinDurationMs);
    const roundedDurationMs = Math.round(durationMs);

    console.log(
      `[distributed-lock] Starting operation on resource "${resourceId}" (will take ${roundedDurationMs}ms)`
    );

    // Simulate a long-running operation
    // In production, this would be replaced with actual business logic
    await this.sleep(roundedDurationMs);

    // Example: You might have logic like:
    // - Update database records
    // - Process files
    // - Call external APIs
    // - Generate reports
    // etc.

    return roundedDurationMs;
  }

  /**
   * Utility function to sleep for a specified duration
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
