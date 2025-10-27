import { Redis } from 'ioredis';
import crypto from 'crypto';
import { StampedeResponse, StampedeMetadata } from '../interfaces';
import { simulateExpensiveOperation } from '../../utils/expensive-operation';

/**
 * Cache Stampede Prevention Service
 *
 * Prevents the "thundering herd" or "cache stampede" problem where multiple concurrent
 * requests attempt to recompute an expensive operation when a cache entry expires.
 *
 * ## The Problem:
 * When a popular cache entry expires:
 * - Request 1 arrives → cache miss → starts computation (2s)
 * - Request 2 arrives → cache miss → starts computation (2s) [DUPLICATE!]
 * - Request 3-100 arrive → all start duplicate computations
 * - Result: 100 identical expensive operations, database overload
 *
 * ## Why This Approach (Pub/Sub with Lock)?
 *
 * We evaluated several alternatives:
 *
 * ### ❌ Alternative 1: Do Nothing (Naive Caching)
 * - Problem: Every concurrent request triggers computation
 * - Performance: 100 requests = 100 DB queries (worst case)
 * - Use case: Only acceptable for fast operations (<50ms) or low traffic
 *
 * ### ❌ Alternative 2: Lock with Polling
 * - How it works: Losers poll cache repeatedly (every 50ms) until data appears
 * - Problem: ~4,000 Redis operations for 100 requests over 2s computation time
 * - Trade-off: Simple to implement but wastes resources at scale
 * - Redis ops: 100 requests × (2000ms / 50ms poll interval) = ~4,000 operations
 *
 * ### ❌ Alternative 3: Probabilistic Early Expiration (PER)
 * - How it works: Refresh cache probabilistically before actual expiration
 * - Formula: currentTime - (delta * beta * log(rand())) >= expiry
 * - Problem: Still allows stampedes, just makes them less likely
 * - Trade-off: No additional infrastructure but doesn't eliminate the problem
 * - Use case: Good for gradual traffic, bad for bursty traffic
 *
 * ### ❌ Alternative 4: Always Background Refresh
 * - How it works: Serve stale data while refreshing in background
 * - Problem: Users may see stale data, requires cache to never truly expire
 * - Trade-off: Best user experience but complex implementation
 * - See: refresh-ahead.service.ts for this pattern
 *
 * ### ✅ This Approach: Lock with Pub/Sub (Winner for High Concurrency)
 * - How it works:
 *   1. First request acquires lock, computes, publishes "ready" event
 *   2. Other requests subscribe and wait for "ready" notification
 *   3. All wake up simultaneously when data is ready
 * - Performance: ~201 Redis operations (50× reduction vs polling)
 * - Redis ops breakdown:
 *   - 100 GET (cache check) = 100 ops
 *   - 1 SET (lock) + 100 failed SETs = 101 ops
 *   - Winner: 1 computation + 1 cache SET + 1 PUBLISH = 3 ops
 *   - 99 SUBSCRIBE + 99 UNSUBSCRIBE = 198 ops (but non-blocking)
 *   - Total: ~201 ops vs ~4,000 for polling
 * - Trade-off: More complex code, requires pub/sub infrastructure
 * - Use case: High concurrency (>100 requests), expensive operations (>2s)
 *
 * ## Implementation Details:
 * - Lock TTL: 30s (auto-expires if holder crashes)
 * - Wait timeout: 30s (fallback to compute if notification never arrives)
 * - Unique lock values: Prevents accidental deletion of another process's lock
 * - Lua script for lock release: Atomic check-and-delete
 * - Separate Redis client per subscriber: Required by Redis pub/sub model
 * - Race condition handling: Double-check cache after subscribing
 */
export class StampedePreventionService {
  // ============================================================================
  // CONFIGURATION CONSTANTS
  // ============================================================================

  // Key prefixes for Redis namespace isolation
  private readonly KEY_PREFIX = 'stampede:'; // Cached data: stampede:mykey
  private readonly LOCK_PREFIX = 'lock:stampede:'; // Distributed lock: lock:stampede:mykey
  private readonly CHANNEL_PREFIX = 'cache-ready:'; // Pub/sub channel: cache-ready:mykey

  // Timing configuration - tune these based on your use case
  private readonly DEFAULT_TTL = 300; // 5 minutes: How long to cache successful computations
  private readonly LOCK_TTL = 30; // 30 seconds: Maximum time one request can hold the lock
  // Should be >= your longest expected computation time
  private readonly MAX_WAIT_TIME = 30000; // 30 seconds: How long losers wait before giving up
  // Should match LOCK_TTL to handle crashed lock holders
  private readonly COMPUTATION_DELAY = 2000; // 2 seconds: Simulated expensive operation delay for demo

  constructor(private readonly redis: Redis) {}

  // ============================================================================
  // PUBLIC API
  // ============================================================================

  /**
   * Get data with stampede prevention.
   *
   * This is the main entry point. It implements the "check-lock-compute-or-wait" pattern:
   *
   * Flow for FIRST request (winner):
   *   1. Check cache → miss
   *   2. Acquire lock → success
   *   3. Compute expensive operation
   *   4. Store in cache
   *   5. Publish "ready" notification
   *   6. Release lock
   *   7. Return data
   *
   * Flow for CONCURRENT requests (losers):
   *   1. Check cache → miss
   *   2. Try acquire lock → fail (already held)
   *   3. Subscribe to "cache-ready" channel
   *   4. Double-check cache (race condition handling)
   *   5. Wait for notification (max 30s)
   *   6. Read from cache and return
   *
   * Edge cases handled:
   * - Lock holder crashes: Lock auto-expires after 30s, losers timeout and compute
   * - Pub/sub message lost: Timeout triggers fallback computation
   * - Race condition: Double-check cache after subscribing
   * - Cache disappeared after notification: Fallback computation
   *
   * @param key - The cache key to get/compute
   * @returns Promise containing data and metadata about the operation
   */
  async get(key: string): Promise<StampedeResponse<any>> {
    const startTime = Date.now();
    const cacheKey = `${this.KEY_PREFIX}${key}`; // e.g., "stampede:report1"
    const lockKey = `${this.LOCK_PREFIX}${key}`; // e.g., "lock:stampede:report1"
    const channelKey = `${this.CHANNEL_PREFIX}${key}`; // e.g., "cache-ready:report1"

    // ========================================================================
    // STEP 1: Check if data is already cached (fast path)
    // ========================================================================
    // This is the happy path - most requests should hit this
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      const ttl = await this.redis.ttl(cacheKey);
      console.log(`[Stampede] Cache hit for key: ${key}`);

      return {
        data: JSON.parse(cached),
        metadata: {
          key,
          source: 'cache',
          timeTaken: Date.now() - startTime,
          ttl,
        },
      };
    }

    console.log(`[Stampede] Cache miss for key: ${key}`);

    // ========================================================================
    // STEP 2: Cache miss - try to acquire the lock to become the "winner"
    // ========================================================================
    // Only ONE request will successfully acquire the lock
    // Using SET NX EX ensures atomicity (no race condition between check and set)
    const lockValue = this.generateLockValue();
    const lockAcquired = await this.tryAcquireLock(lockKey, lockValue);

    if (lockAcquired) {
      // ======================================================================
      // PATH A: We won the lock - we are responsible for computing the data
      // ======================================================================
      console.log(`[Stampede] Lock acquired for key: ${key}`);

      try {
        const data = await this.computeAndCache(key, cacheKey, channelKey);

        return {
          data,
          metadata: {
            key,
            source: 'computed',
            timeTaken: Date.now() - startTime,
            ttl: this.DEFAULT_TTL,
            lockAcquired: true,
            waitedForLock: false,
          },
        };
      } finally {
        // CRITICAL: Always release lock, even if computation fails
        // This prevents deadlock if our process crashes mid-computation
        // (Though lock will auto-expire anyway after LOCK_TTL seconds)
        await this.releaseLock(lockKey, lockValue);
      }
    } else {
      // ======================================================================
      // PATH B: Lock already held - we're a "loser", wait for the winner
      // ======================================================================
      console.log(
        `[Stampede] Lock acquisition failed, waiting for key: ${key}`
      );
      const waitStart = Date.now();

      try {
        // Wait for winner to publish "ready" notification
        await this.waitForCacheReady(channelKey, cacheKey);
        const waitTimeMs = Date.now() - waitStart;

        // Read from cache after receiving notification
        const cached = await this.redis.get(cacheKey);
        if (!cached) {
          // Edge case: Got notification but cache is empty (should be rare)
          // Possible causes: cache evicted, winner crashed after publish, etc.
          console.warn(
            `[Stampede] Received notification but cache empty for key: ${key}, computing anyway`
          );
          const data = await this.computeAndCache(key, cacheKey, channelKey);
          return {
            data,
            metadata: {
              key,
              source: 'computed',
              timeTaken: Date.now() - startTime,
              ttl: this.DEFAULT_TTL,
              lockAcquired: false,
              waitedForLock: true,
              waitTimeMs,
            },
          };
        }

        const ttl = await this.redis.ttl(cacheKey);
        return {
          data: JSON.parse(cached),
          metadata: {
            key,
            source: 'cache',
            timeTaken: Date.now() - startTime,
            ttl,
            lockAcquired: false,
            waitedForLock: true,
            waitTimeMs,
          },
        };
      } catch (error) {
        // Fallback: If waiting fails (timeout, network error, etc.), compute anyway
        // This is graceful degradation - better to duplicate work than fail the request
        console.error(`[Stampede] Error waiting for key: ${key}`, error);
        const data = await this.computeAndCache(key, cacheKey, channelKey);
        return {
          data,
          metadata: {
            key,
            source: 'computed',
            timeTaken: Date.now() - startTime,
            ttl: this.DEFAULT_TTL,
            lockAcquired: false,
            waitedForLock: true,
            waitTimeMs: Date.now() - waitStart,
          },
        };
      }
    }
  }

  /**
   * Invalidate (delete) a cache entry.
   *
   * Useful for:
   * - Testing stampede scenarios repeatedly
   * - Manual cache invalidation when data changes
   * - Forcing recomputation of stale data
   *
   * Note: This only deletes the cached data, not any active locks.
   * Active locks will expire naturally after LOCK_TTL seconds.
   */
  async invalidate(key: string): Promise<boolean> {
    const cacheKey = `${this.KEY_PREFIX}${key}`;
    const deleted = await this.redis.del(cacheKey);
    console.log(
      `[Stampede] Invalidated cache for key: ${key}, deleted: ${deleted > 0}`
    );
    return deleted > 0;
  }

  // ============================================================================
  // PRIVATE HELPERS - Lock Management
  // ============================================================================

  /**
   * Try to acquire a distributed lock using Redis SET with NX (Not eXists) and EX (EXpire).
   *
   * Why SET NX EX instead of separate commands?
   * - Atomicity: SET NX EX is a single atomic operation
   * - If we did GET + SET separately, two processes could both see "not exists" and both acquire
   * - The EX ensures lock auto-expires even if holder crashes (self-healing)
   *
   * Why unique lock value?
   * - Prevents process A from accidentally releasing process B's lock
   * - Scenario: A gets lock, A times out, lock expires, B gets lock, A wakes up and tries to release
   * - With unique value, A's release will fail because value doesn't match B's
   *
   * @param lockKey - The Redis key for the lock (e.g., "lock:stampede:report1")
   * @param lockValue - Unique identifier (UUID:timestamp) to prove ownership
   * @returns true if lock acquired, false if already held by another process
   */
  private async tryAcquireLock(
    lockKey: string,
    lockValue: string
  ): Promise<boolean> {
    const result = await this.redis.set(
      lockKey,
      lockValue,
      'EX',
      this.LOCK_TTL,
      'NX'
    );
    return result === 'OK';
  }

  /**
   * Release lock safely using Lua script.
   *
   * Why Lua script instead of GET + DEL?
   * - Atomicity: Lua scripts execute atomically in Redis
   * - Race condition: Without atomicity, lock could expire between our GET and DEL,
   *   and we'd accidentally delete another process's new lock
   *
   * The script only deletes if the lock value matches, proving we own it.
   *
   * This is the standard pattern for distributed locks (see Redis docs on locks).
   */
  private async releaseLock(lockKey: string, lockValue: string): Promise<void> {
    const luaScript = `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
      else
        return 0
      end
    `;

    await this.redis.eval(luaScript, 1, lockKey, lockValue);
    console.log(`[Stampede] Released lock: ${lockKey}`);
  }

  // ============================================================================
  // PRIVATE HELPERS - Pub/Sub Waiting
  // ============================================================================

  /**
   * Wait for cache ready notification using Redis Pub/Sub.
   *
   * Why Pub/Sub instead of polling?
   * - Efficiency: One SUBSCRIBE vs hundreds of GET calls
   * - Latency: Instant wake-up (<5ms) vs polling interval variance (0-50ms)
   * - Scale: Constant overhead regardless of number of waiters
   *
   * Critical race condition handling:
   * 1. Subscribe FIRST (before checking cache)
   * 2. Then double-check cache
   * 3. Then wait for message
   *
   * Why this order matters:
   * - Bad order: Check cache → subscribe → wait
   *   Problem: Winner could publish between our check and subscribe, we'd miss it forever
   * - Good order: Subscribe → check cache → wait
   *   If winner published already, we'll see data in step 2 and skip waiting
   *   If winner publishes later, we're already subscribed and will receive it
   *
   * Why separate Redis client?
   * - Redis limitation: A client in SUBSCRIBE mode cannot execute other commands (GET, SET, etc.)
   * - We need to SUBSCRIBE and also GET cache, so we need two clients
   * - We duplicate() our main client to create an independent connection
   *
   * @param channelKey - The pub/sub channel to subscribe to (e.g., "cache-ready:report1")
   * @param cacheKey - The cache key to double-check (e.g., "stampede:report1")
   */
  private async waitForCacheReady(
    channelKey: string,
    cacheKey: string
  ): Promise<void> {
    console.log(`[Stampede] Waiting for notification: ${channelKey}`);

    // Create separate Redis client for pub/sub (required by Redis)
    const subscriber = this.redis.duplicate();

    try {
      // Step 1: Subscribe first (before checking cache to avoid race condition)
      await subscriber.subscribe(channelKey);

      // Step 2: Double-check cache (race condition: publish may have happened already)
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        console.log(
          `[Stampede] Cache appeared during subscribe, no need to wait: ${cacheKey}`
        );
        return;
      }

      // Step 3: Wait for message with timeout
      const message = await this.waitForMessage(subscriber, channelKey);

      if (!message) {
        console.warn(
          `[Stampede] Timeout waiting for key: ${channelKey}, computing anyway`
        );
        throw new Error('Timeout waiting for cache ready notification');
      }

      console.log(`[Stampede] Received notification for: ${channelKey}`);
    } finally {
      // CRITICAL: Always cleanup to prevent memory leaks
      // Unsubscribe before disconnecting to be polite to Redis
      await subscriber.unsubscribe(channelKey);
      subscriber.disconnect();
    }
  }

  /**
   * Wait for a pub/sub message with timeout.
   *
   * Why timeout?
   * - Prevents infinite waiting if lock holder crashes before publishing
   * - Lock has TTL (30s), so if holder crashes, lock expires and another process can compute
   * - We timeout after same duration to trigger fallback computation
   *
   * Implementation using Promise:
   * - Sets up message listener
   * - Sets up timeout that resolves with null
   * - Whichever happens first wins
   * - Cleanup: Remove listener to prevent memory leak
   */
  private waitForMessage(
    subscriber: Redis,
    channelKey: string
  ): Promise<string | null> {
    return new Promise(resolve => {
      const timeout = setTimeout(() => {
        subscriber.removeAllListeners('message');
        resolve(null);
      }, this.MAX_WAIT_TIME);

      subscriber.on('message', (channel, message) => {
        if (channel === channelKey) {
          clearTimeout(timeout);
          subscriber.removeAllListeners('message');
          resolve(message);
        }
      });
    });
  }

  // ============================================================================
  // PRIVATE HELPERS - Data Computation
  // ============================================================================

  /**
   * Compute expensive operation and cache the result.
   * Then publish notification to wake all waiting requests.
   *
   * This is called by:
   * 1. The lock holder (winner) - normal path
   * 2. Any request as fallback if waiting times out
   *
   * Publishing to pub/sub:
   * - Returns number of subscribers who received the message
   * - In stampede scenario, this is typically 99 for 100 concurrent requests (all losers)
   * - If 0, that's fine - means no one was waiting (perhaps all timed out already)
   *
   * @param key - The original key requested by the user
   * @param cacheKey - The full Redis key with prefix (e.g., "stampede:report1")
   * @param channelKey - The pub/sub channel to publish to (e.g., "cache-ready:report1")
   */
  private async computeAndCache(
    key: string,
    cacheKey: string,
    channelKey: string
  ): Promise<any> {
    console.log(`[Stampede] Computing expensive operation for key: ${key}`);

    // Simulate expensive operation (e.g., database query, API call, ML inference)
    // In real code, replace this with your actual expensive operation
    const data = await simulateExpensiveOperation(key, this.COMPUTATION_DELAY);

    // Store in cache with TTL
    // TTL ensures stale data eventually expires (but see refresh-ahead pattern for proactive refresh)
    await this.redis.set(
      cacheKey,
      JSON.stringify(data),
      'EX',
      this.DEFAULT_TTL
    );
    console.log(`[Stampede] Cached result for key: ${key}`);

    // Publish notification to wake all waiting requests
    // Redis pub/sub doesn't guarantee delivery, but that's OK - waiters have timeout fallback
    const subscribers = await this.redis.publish(channelKey, 'ready');
    console.log(
      `[Stampede] Published notification for key: ${key}, reached ${subscribers} subscribers`
    );

    return data;
  }

  /**
   * Generate unique lock value to prove ownership.
   *
   * Format: UUID:timestamp
   * - UUID: Guarantees uniqueness across processes
   * - Timestamp: Helps debugging (can see when lock was acquired)
   *
   * Alternative approaches considered:
   * - Process ID: Not unique across machines in distributed system
   * - Random number: Possible collision (though unlikely)
   * - UUID only: Sufficient, but timestamp helps debugging
   */
  private generateLockValue(): string {
    return `${crypto.randomUUID()}:${Date.now()}`;
  }
}
