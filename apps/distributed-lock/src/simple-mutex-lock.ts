import { randomBytes } from 'crypto';
import type Redis from 'ioredis';

export interface AcquireLockResult {
  success: boolean;
  /** Unique lock ID if successful, undefined otherwise */
  lockId?: string;
  /** Time in milliseconds to wait before retrying if lock acquisition failed */
  retryAfter?: number;
}

export interface ReleaseLockResult {
  success: boolean;
}

/**
 * Service for managing distributed locks using Valkey/Redis
 *
 * This implementation provides distributed locking:
 * - Lock acquisition using SET with NX (only set if not exists) and PX (TTL in milliseconds)
 * - Atomic lock release using Lua scripts
 * - Fail-fast behavior on contention (no waiting/blocking)
 *
 * IMPORTANT SAFETY CAVEAT:
 * This implementation does NOT guarantee mutual exclusion in the face of Redis/Valkey
 * cluster failover. If the primary node crashes before replicating the lock to replicas,
 * another process may acquire the same lock on the promoted replica.
 *
 * For stricter guarantees, consider using the Redlock algorithm.
 */
export class SimpleMutexLock {
  private readonly redis: Redis;
  private readonly keyPrefix: string;

  constructor(options: { redis: Redis; keyPrefix?: string }) {
    this.redis = options.redis;
    this.keyPrefix = options.keyPrefix || 'distributed-lock:';
  }

  /**
   * Attempts to acquire a distributed lock for the given resource
   *
   * @param resource - The resource identifier to lock
   * @param ttlMs - Time-to-live for the lock in milliseconds
   * @returns Result indicating success/failure and lock ID or retry time
   */
  async acquire(resource: string, ttlMs: number): Promise<AcquireLockResult> {
    const lockId = this.generateLockId();
    const key = this.getLockKey(resource);

    try {
      // Try to acquire the lock using SET with NX (only set if not exists) and PX (expiration in ms)
      // Redis/ioredis SET command: SET key value [EX seconds|PX milliseconds] [NX|XX]
      const result = await this.redis.set(key, lockId, 'PX', ttlMs, 'NX');

      if (result === 'OK') {
        return {
          success: true,
          lockId,
        };
      }

      // Lock acquisition failed - get TTL to inform caller when to retry
      const pttl = await this.redis.pttl(key);
      const retryAfter = pttl > 0 ? pttl : ttlMs;

      return {
        success: false,
        retryAfter,
      };
    } catch (error) {
      console.error(
        `[distributed-lock] Failed to acquire lock for resource ${resource}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Releases a distributed lock if and only if the caller owns it
   *
   * Uses a Lua script to atomically check ownership and delete the key,
   * preventing accidental release of a lock acquired by another process.
   *
   * @param resource - The resource identifier to unlock
   * @param lockId - The unique lock ID returned from acquire()
   * @returns Result indicating whether the lock was successfully released
   */
  async release(resource: string, lockId: string): Promise<ReleaseLockResult> {
    const key = this.getLockKey(resource);

    /**
     * Lua script for atomically releasing a lock
     * Only deletes the key if the stored value matches the provided lock ID
     * ARGV[1]: The unique lock ID
     * KEYS[1]: The resource key
     */
    const RELEASE_SCRIPT = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
    `;

    try {
      // Use Lua script to atomically check lock ownership and delete
      // eval(script, numKeys, key1, key2, ..., arg1, arg2, ...)
      const result = await this.redis.eval(RELEASE_SCRIPT, 1, key, lockId);

      return {
        success: result === 1,
      };
    } catch (error) {
      console.error(
        `[distributed-lock] Failed to release lock for resource ${resource}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Generates a cryptographically random lock ID
   * This ensures each lock acquisition has a unique identifier
   */
  private generateLockId(): string {
    return randomBytes(16).toString('hex');
  }

  /**
   * Constructs the full lock key from the resource identifier
   */
  private getLockKey(resource: string): string {
    return `${this.keyPrefix}${resource}`;
  }
}
