import type { Redis } from 'ioredis';
import type { CacheResponse } from '../interfaces';
import { simulateExpensiveOperation } from '../../utils/expensive-operation';

/**
 * Refresh-Ahead Service
 *
 * Implements proactive cache refresh pattern to eliminate cache miss penalties
 * for hot data. When a cache hit occurs and TTL is below a threshold, triggers
 * background refresh while returning current cached value immediately.
 *
 * Pattern flow:
 * 1. Request arrives for key
 * 2. Check cache (GET key)
 * 3. Cache HIT - check TTL (TTL key)
 * 4. If TTL < threshold (e.g., 20% of original TTL):
 *    a. Return current cached value immediately (fast)
 *    b. Try to acquire a lock (to prevent multiple refreshes)
 *    c. If lock acquired, trigger background refresh asynchronously
 * 5. Background: Load new data, update cache, release lock
 * 6. Next request gets fresh data
 *
 * Use cases:
 * - Expensive operations that must always be fast (ML inference, complex queries)
 * - Hot data with frequent access (popular products, trending content)
 * - Cannot tolerate cache miss penalty (real-time dashboards, APIs)
 * - Stale data acceptable temporarily (eventual consistency)
 */
export class RefreshAheadService {
  private readonly KEY_PREFIX = 'refresh-ahead:';
  private readonly LOCK_PREFIX = 'lock:refresh-ahead:';
  private readonly DEFAULT_TTL = 300; // 5 minutes
  private readonly DEFAULT_REFRESH_THRESHOLD = 0.2; // Refresh when TTL < 20% of original
  private readonly LOCK_TTL = 10; // Lock timeout in seconds

  constructor(private readonly redis: Redis) {}

  /**
   * Get data with refresh-ahead logic.
   * Retrieved item will be cached for 5m. Cache will be refreshed if it's read and remaining TTL < 1m.
   *
   * This method:
   * 1. Checks cache first
   * 2. On cache hit, checks TTL
   * 3. If TTL is below threshold, triggers background refresh
   * 4. Returns cached value immediately (never blocks on refresh)
   * 5. On cache miss, loads data synchronously and caches it
   */
  async get(key: string): Promise<CacheResponse<any>> {
    const startTime = Date.now();
    const fullKey = `${this.KEY_PREFIX}${key}`;
    const ttl = this.DEFAULT_TTL;
    const refreshThreshold = this.DEFAULT_REFRESH_THRESHOLD;

    // Try to get from cache
    const cached = await this.redis.get(fullKey);

    if (cached) {
      // Cache HIT - check if refresh needed
      const remainingTtl = await this.redis.ttl(fullKey);
      const refreshTriggerTtl = ttl * refreshThreshold;

      // If TTL is below threshold, trigger background refresh
      if (remainingTtl > 0 && remainingTtl < refreshTriggerTtl) {
        console.log(
          `[Refresh-Ahead] TTL ${remainingTtl}s < threshold ${refreshTriggerTtl}s, triggering background refresh for key: ${key}`
        );
        // Non-blocking background refresh
        this.triggerBackgroundRefresh(key).catch(error => {
          console.error(
            `[Refresh-Ahead] Background refresh failed for key: ${key}`,
            error
          );
        });
      }

      const timeTaken = Date.now() - startTime;
      return {
        data: JSON.parse(cached),
        metadata: {
          key,
          source: 'cache',
          timeTaken,
          ttl: remainingTtl > 0 ? remainingTtl : undefined,
        },
      };
    }

    // Cache MISS - load synchronously
    console.log(
      `[Refresh-Ahead] Cache miss for key: ${key}, loading from source`
    );
    const result = await simulateExpensiveOperation(key);
    await this.redis.setex(fullKey, ttl, JSON.stringify(result));

    const timeTaken = Date.now() - startTime;
    return {
      data: result,
      metadata: {
        key,
        source: 'computed',
        timeTaken,
        ttl,
      },
    };
  }

  /**
   * Get refresh status for a key
   *
   * Useful for monitoring and debugging refresh-ahead behavior
   *
   * @param key - The cache key to check
   * @returns Status information including cache state, TTL, and lock status
   */
  async getRefreshStatus(key: string): Promise<{
    cached: boolean;
    ttl?: number;
    locked: boolean;
    refreshNeeded?: boolean;
  }> {
    const itemKey = `${this.KEY_PREFIX}${key}`;
    const lockKey = `${this.LOCK_PREFIX}${key}`;

    const cached = await this.redis.get(itemKey);
    const locked = (await this.redis.get(lockKey)) !== null;

    if (!cached) {
      return { cached: false, locked };
    }

    const ttl = await this.redis.ttl(itemKey);
    const refreshNeeded =
      ttl > 0 && ttl < this.DEFAULT_TTL * this.DEFAULT_REFRESH_THRESHOLD;

    return {
      cached: true,
      ttl: ttl > 0 ? ttl : undefined,
      locked,
      refreshNeeded,
    };
  }

  /**
   * Invalidate cache entry
   *
   * @param key - The key to invalidate
   * @returns True if key was deleted, false if it didn't exist
   */
  async invalidate(key: string): Promise<boolean> {
    const fullKey = `${this.KEY_PREFIX}${key}`;
    const result = await this.redis.del(fullKey);
    return result > 0;
  }

  /**
   * Trigger background refresh with distributed locking
   *
   * This method:
   * 1. Attempts to acquire a distributed lock (SET NX EX)
   * 2. If lock acquired, refreshes the cache
   * 3. Releases the lock when done
   * 4. If lock not acquired, another instance is already refreshing
   *
   * EDUCATIONAL NOTE - Lock implementation:
   *
   * We use SET key value NX EX seconds for atomic lock acquisition.
   * This is safer than separate SETNX + EXPIRE commands.
   *
   * Lock release uses DEL, but in production you should use a Lua script
   * to ensure you only delete your own lock:
   *
   * ```lua
   * if redis.call("get", KEYS[1]) == ARGV[1] then
   *   return redis.call("del", KEYS[1])
   * else
   *   return 0
   * end
   * ```
   *
   * This prevents accidentally deleting a lock acquired by another process
   * if your refresh takes longer than the lock TTL.
   */
  private async triggerBackgroundRefresh(key: string): Promise<void> {
    const lockKey = `${this.LOCK_PREFIX}${key}`;
    const lockValue = `${Date.now()}`; // Unique lock identifier
    const itemKey = `${this.KEY_PREFIX}${key}`;

    // Try to acquire lock (SET NX EX)
    const lockAcquired = await this.redis.set(
      lockKey,
      lockValue,
      'EX',
      this.LOCK_TTL,
      'NX'
    );

    if (!lockAcquired) {
      console.log(
        `[Refresh-Ahead] Lock already held for key: ${key}, skipping refresh (another instance is refreshing)`
      );
      return;
    }

    try {
      console.log(`[Refresh-Ahead] Lock acquired, refreshing key: ${key}`);

      // Load fresh data
      const result = await simulateExpensiveOperation(key);

      // Update cache with new TTL
      await this.redis.setex(itemKey, this.DEFAULT_TTL, JSON.stringify(result));

      console.log(`[Refresh-Ahead] Successfully refreshed key: ${key}`);
    } catch (error) {
      console.error(`[Refresh-Ahead] Failed to refresh key: ${key}`, error);
      throw error;
    } finally {
      // Release lock
      // EDUCATIONAL NOTE: In production, use Lua script to verify lock ownership before deletion
      await this.redis.del(lockKey);
      console.log(`[Refresh-Ahead] Lock released for key: ${key}`);
    }
  }
}
