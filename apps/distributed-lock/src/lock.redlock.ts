import Redlock, { Lock } from 'redlock';
import type Redis from 'ioredis';
import {
  DistributedLock,
  AcquireLockResult,
  ReleaseLockResult,
} from './lock.interface';

/**
 * Configuration options for RedLock implementation
 */
export interface RedLockOptions {
  /** Array of Redis/Valkey client instances (minimum 3, recommended 5) */
  redisInstances: Redis[];
  /** Key prefix for lock keys (default: 'lock:') */
  keyPrefix?: string;
  /** Number of times to retry acquisition if it fails (default: 3) */
  retryCount?: number;
  /** Time between retries in milliseconds (default: 200) */
  retryDelay?: number;
  /** Maximum time between retries in milliseconds (default: 1000) */
  retryJitter?: number;
  /** Clock drift factor as a percentage (default: 0.01 = 1%) */
  driftFactor?: number;
  /** Automatic extension threshold (default: 500ms) */
  automaticExtensionThreshold?: number;
}

/**
 * RedLock implementation for distributed locking across multiple Redis/Valkey instances
 *
 * This implementation provides the strongest safety guarantees by using the Redlock algorithm:
 * - Acquires locks on a majority of N independent instances
 * - Survives single-instance failures
 * - No single point of failure
 * - Clock drift tolerance
 *
 * Architecture:
 * - Recommended setup: 5 independent Redis/Valkey instances
 * - Quorum: Majority (≥3 out of 5)
 * - Each instance is completely independent (no replication between them)
 *
 * Safety Guarantees:
 * - Mutual exclusion maintained even if minority of instances fail
 * - Accounts for clock drift across servers
 * - Lock validity automatically adjusted for network latency
 *
 * IMPORTANT:
 * - All instances should be independent (not master-slave pairs)
 * - NTP or similar time synchronization highly recommended
 * - See README.md for detailed discussion of safety guarantees and limitations
 *
 * @see https://github.com/mike-marcacci/node-redlock
 * @see https://redis.io/topics/distlock
 */
export class RedLock implements DistributedLock {
  private readonly redlock: Redlock;
  private readonly keyPrefix: string;
  private readonly activeLocks: Map<string, Lock>;
  private readonly instanceCount: number;

  constructor(options: RedLockOptions) {
    if (!options.redisInstances || options.redisInstances.length < 3) {
      throw new Error(
        'RedLock requires at least 3 Redis instances. Recommended: 5 instances for optimal fault tolerance.'
      );
    }

    // Ensure odd number of instances for clear majority
    if (options.redisInstances.length % 2 === 0) {
      console.warn(
        '[redlock] Warning: Even number of Redis instances detected. Odd numbers (3, 5, 7) provide clearer quorum semantics.'
      );
    }

    this.keyPrefix = options.keyPrefix || 'lock:';
    this.activeLocks = new Map();
    this.instanceCount = options.redisInstances.length;

    // Initialize Redlock with configuration
    this.redlock = new Redlock(options.redisInstances, {
      // The expected clock drift; for more details see:
      // http://redis.io/topics/distlock
      driftFactor: options.driftFactor || 0.01, // 1% clock drift tolerance

      // The max number of times Redlock will attempt to lock a resource
      // before erroring
      retryCount: options.retryCount ?? 3,

      // The time in ms between attempts
      retryDelay: options.retryDelay || 200,

      // The max time in ms randomly added to retries to improve performance
      // under high contention
      retryJitter: options.retryJitter || 200,

      // The minimum remaining time on a lock before an extension is automatically
      // attempted with the `using` API
      automaticExtensionThreshold:
        options.automaticExtensionThreshold || 500,
    });

    // Listen for errors
    this.redlock.on('error', (error) => {
      // Ignore cases where a resource is explicitly marked as locked on a client
      if (error.message.includes('Resource is already locked')) {
        return;
      }
      console.error('[redlock] Redlock error:', error);
    });

    console.log(
      `[redlock] Initialized with ${options.redisInstances.length} instances, quorum: ${Math.floor(options.redisInstances.length / 2) + 1}`
    );
  }

  /**
   * Attempts to acquire a distributed lock using the Redlock algorithm
   *
   * This method:
   * 1. Generates a unique lock identifier
   * 2. Attempts to acquire the lock on all Redis instances
   * 3. Checks if majority (quorum) was achieved
   * 4. Validates that sufficient validity time remains
   * 5. Returns success if both conditions met, otherwise releases and fails
   *
   * @param resource - The resource identifier to lock
   * @param ttlMs - Time-to-live for the lock in milliseconds
   * @returns Result indicating success/failure, lock ID, and metadata about acquisition
   */
  async acquire(resource: string, ttlMs: number): Promise<AcquireLockResult> {
    const key = this.getLockKey(resource);

    try {
      // Attempt to acquire the lock on majority of instances
      const lock = await this.redlock.acquire([key], ttlMs);

      // Store the lock for later release
      this.activeLocks.set(key, lock);

      console.log(
        `[redlock] Lock acquired for resource "${resource}" (expires in ${ttlMs}ms)`
      );

      return {
        success: true,
        lockId: lock.value, // The unique identifier for this lock
        metadata: {
          expiration: lock.expiration,
          attempts: 1, // Redlock library handles retries internally
        },
      };
    } catch (error) {
      // Lock acquisition failed (quorum not reached or timeout)
      console.log(
        `[redlock] Failed to acquire lock for resource "${resource}":`,
        error instanceof Error ? error.message : error
      );

      // Calculate retry time based on TTL
      // If we couldn't acquire the lock, someone else holds it
      const retryAfter = ttlMs;

      return {
        success: false,
        retryAfter,
        metadata: {
          error: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  }

  /**
   * Releases a distributed lock across all Redis instances
   *
   * This method:
   * 1. Verifies the lock is still tracked
   * 2. Attempts to release the lock on all instances
   * 3. Removes the lock from internal tracking
   *
   * Note: The lockId parameter is used to verify ownership through the
   * Redlock library's internal mechanisms.
   *
   * @param resource - The resource identifier to unlock
   * @param lockId - The unique lock ID returned from acquire()
   * @returns Result indicating whether the lock was successfully released
   */
  async release(resource: string, lockId: string): Promise<ReleaseLockResult> {
    const key = this.getLockKey(resource);
    const lock = this.activeLocks.get(key);

    if (!lock) {
      // Lock not found - may have already been released or expired
      console.warn(
        `[redlock] Attempted to release non-existent or already released lock for resource "${resource}"`
      );
      return {
        success: false,
        metadata: {
          reason: 'Lock not found in active locks',
        },
      };
    }

    // Verify lock ownership
    if (lock.value !== lockId) {
      console.warn(
        `[redlock] Attempted to release lock with mismatched lockId for resource "${resource}"`
      );
      return {
        success: false,
        metadata: {
          reason: 'Lock ID mismatch',
        },
      };
    }

    try {
      // Release the lock across all instances
      await lock.release();

      // Remove from tracking
      this.activeLocks.delete(key);

      console.log(`[redlock] Lock released for resource "${resource}"`);

      return {
        success: true,
        metadata: {
          releasedAt: Date.now(),
        },
      };
    } catch (error) {
      console.error(
        `[redlock] Error releasing lock for resource "${resource}":`,
        error
      );

      // Even if release failed, remove from tracking to prevent memory leak
      this.activeLocks.delete(key);

      return {
        success: false,
        metadata: {
          error: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  }

  /**
   * Constructs the full lock key from the resource identifier
   */
  private getLockKey(resource: string): string {
    return `${this.keyPrefix}${resource}`;
  }

  /**
   * Gets the number of Redis instances configured
   */
  getInstanceCount(): number {
    return this.instanceCount;
  }

  /**
   * Gets the required quorum (majority) for lock acquisition
   */
  getQuorum(): number {
    return Math.floor(this.instanceCount / 2) + 1;
  }

  /**
   * Cleanup method to release all active locks and disconnect
   * Should be called during application shutdown
   */
  async shutdown(): Promise<void> {
    console.log(
      `[redlock] Shutting down, releasing ${this.activeLocks.size} active locks`
    );

    // Release all active locks
    const releasePromises = Array.from(this.activeLocks.values()).map(
      (lock) => lock.release().catch((err) => console.error(err))
    );

    await Promise.allSettled(releasePromises);

    this.activeLocks.clear();

    // Quit Redlock (closes connections if needed)
    await this.redlock.quit();

    console.log('[redlock] Shutdown complete');
  }
}
