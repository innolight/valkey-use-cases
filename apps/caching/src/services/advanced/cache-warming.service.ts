import type { Redis } from 'ioredis';
import type {
  WarmingOptions,
  WarmingResult,
  BatchMetric,
  CacheResponse,
} from '../interfaces';
import {
  simulateExpensiveOperationBatch,
  chunkArray,
} from '../../utils/expensive-operation';

/**
 * Cache Warming Service
 *
 * Implements proactive cache warming (pre-loading) pattern.
 * Unlike reactive patterns (cache-aside, read-through), this service loads
 * data into the cache BEFORE requests arrive, eliminating cold start penalties.
 *
 * Use cases:
 * - Application startup (ensure cache is hot before accepting traffic)
 * - Post-deployment warming (refresh cache with new data)
 * - Scheduled warming (maintain cache during off-peak hours)
 * - Pre-event warming (prepare for anticipated traffic spikes)
 */
export class CacheWarmingService {
  private readonly KEY_PREFIX = 'cache-warming:';
  private readonly DEFAULT_TTL = 3600; // 1 hour
  private readonly DEFAULT_BATCH_SIZE = 10;
  private scheduledInterval?: ReturnType<typeof setInterval>;

  constructor(private readonly redis: Redis) {}

  /**
   * Main warming method - loads keys into cache with controlled batch processing
   *
   * This method:
   * 1. Determines which keys to warm (default: getCacheKeysToWarm())
   * 2. Splits keys into batches based on batch size limit
   * 3. Processes batches sequentially, keys within batch in parallel
   * 4. Tracks timing and success/failure per batch
   * 5. Returns comprehensive metrics
   *
   * @param options - Optional configuration
   * @returns WarmingResult with detailed metrics
   */
  async warmCache(options?: WarmingOptions): Promise<WarmingResult> {
    const startTime = Date.now();
    const keys = options?.keys || this.getCacheKeysToWarm();
    const batchSize = options?.batchSize || this.DEFAULT_BATCH_SIZE;
    const ttl = options?.ttl || this.DEFAULT_TTL;
    const delay = options?.delay || 1000;

    // Split keys into chunks for batch processing
    const batches = chunkArray(keys, batchSize);
    const batchMetrics: BatchMetric[] = [];
    let successCount = 0;
    let failureCount = 0;

    // Process each batch sequentially
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const batchResult = await this.processBatch(batch, delay, ttl);

      batchMetrics.push({
        batchNumber: i + 1,
        keysInBatch: batch.length,
        timeMs: batchResult.timeMs,
      });

      successCount += batchResult.successCount;
      failureCount += batchResult.failureCount;
    }

    const totalTimeMs = Date.now() - startTime;
    const result = {
      success: true,
      metadata: {
        totalKeys: keys.length,
        successCount,
        failureCount,
        totalTimeMs,
        batchMetrics,
      },
    };
    console.log(
      `[Cache Warming] Completed: ${result.metadata.successCount}/${result.metadata.totalKeys} keys in ${result.metadata.totalTimeMs}ms`
    );

    return result;
  }

  /**
   * Generates list of keys to warm (100 sample keys)
   *
   * EDUCATIONAL NOTE - In production, key identification strategies include:
   *
   * 1. Analytics-based: Query most-accessed keys from logs/database
   *    Example:
   *    ```sql
   *    SELECT key, COUNT(*) as hits
   *    FROM access_logs
   *    WHERE timestamp > NOW() - INTERVAL '7 days'
   *    GROUP BY key
   *    ORDER BY hits DESC
   *    LIMIT 100
   *    ```
   *
   * 2. Redis monitoring: Analyze MONITOR output or use redis-rdb-tools
   *    to identify frequently accessed keys
   *
   * 3. Business logic: Domain-specific hot data
   *    - Featured products in e-commerce
   *    - VIP user profiles
   *    - Trending content
   *    - Global configuration
   *    - Homepage data
   *
   * 4. Machine Learning: Predict likely access patterns
   *    - Time of day patterns
   *    - Day of week trends
   *    - Seasonal variations
   *    - Event-driven predictions
   *
   * 5. Hybrid approach: Combine multiple strategies
   *    - Critical keys (always warm)
   *    - Analytics-driven keys (dynamic)
   *    - Predicted keys (ML-based)
   *
   * @returns Array of keys to warm
   */
  getCacheKeysToWarm(): string[] {
    // Generate 100 sample keys for demonstration
    return Array.from({ length: 100 }, (_, i) => `item${i + 1}`);
  }

  /**
   * Retrieve a warmed key from cache
   *
   * IMPORTANT: This method does NOT fall back to loading data if not found.
   * Cache warming is proactive - keys must be explicitly warmed beforehand.
   * This demonstrates the difference from reactive patterns (cache-aside).
   *
   * @param key - The key to retrieve (without prefix)
   * @returns CacheResponse if found, null if not found
   */
  async get(key: string): Promise<CacheResponse<any> | null> {
    const startTime = Date.now();
    const fullKey = `${this.KEY_PREFIX}${key}`;

    const cached = await this.redis.get(fullKey);

    if (!cached) {
      return null;
    }

    const ttl = await this.redis.ttl(fullKey);
    const timeTaken = Date.now() - startTime;

    return {
      data: JSON.parse(cached),
      metadata: {
        key,
        source: 'cache',
        timeTaken,
        ttl: ttl > 0 ? ttl : undefined,
      },
    };
  }

  /**
   * Start scheduled warming with setInterval
   *
   * EDUCATIONAL NOTE - Production considerations:
   *
   * 1. Distributed Locking: Prevent multiple instances from warming simultaneously
   *    ```typescript
   *    const lockKey = 'lock:cache-warming';
   *    const lockValue = `${hostname}:${process.pid}:${Date.now()}`;
   *    const lockTTL = 300; // 5 minutes
   *
   *    const acquired = await redis.set(lockKey, lockValue, 'NX', 'EX', lockTTL);
   *    if (!acquired) {
   *      console.log('Another instance is warming, skipping...');
   *      return;
   *    }
   *    ```
   *
   * 2. Job Queue Alternative: For robust scheduling with persistence
   *    - Use Bull/BullMQ with Valkey backend
   *    - Benefits: retry logic, monitoring, distributed coordination
   *    - Example: Use BullMQ to schedule recurring jobs with cron syntax
   *
   * 3. Monitoring: Track warming health
   *    - Success rate (alert if < 95%)
   *    - Duration (alert if > threshold)
   *    - Failed keys (investigate patterns)
   *    - Memory impact
   *
   * 4. Graceful degradation: Handle failures gracefully
   *    - Don't crash on warming failures
   *    - Log errors for investigation
   *    - Alert on repeated failures
   *
   * @param intervalMs - Interval in milliseconds (default: 6 hours)
   */
  startScheduledWarming(intervalMs = 6 * 60 * 60 * 1000): void {
    // Clear any existing interval
    if (this.scheduledInterval) {
      clearInterval(this.scheduledInterval);
    }

    this.scheduledInterval = setInterval(async () => {
      try {
        console.log('[Cache Warming] Starting scheduled Cache warming...');
        await this.warmCache();
      } catch (error) {
        console.error('[Cache Warming] Scheduled warming failed:', error);
        // In production: emit metrics, send alerts, but don't crash
      }
    }, intervalMs);

    console.log(
      `[Cache Warming] Scheduled warming enabled (interval: ${intervalMs / 1000 / 60}minutes)`
    );
  }

  /**
   * Stop scheduled warming
   * Called during graceful shutdown
   */
  stopScheduledWarming(): void {
    if (this.scheduledInterval) {
      clearInterval(this.scheduledInterval);
      this.scheduledInterval = undefined;
      console.log('[Cache Warming] Scheduled warming stopped');
    }
  }

  /**
   * Internal: Process a batch of keys in parallel
   *
   * @param keys - Batch of keys to process
   * @param delay - Simulated operation delay
   * @param ttl - Cache TTL in seconds
   * @returns Batch processing result with metrics
   */
  private async processBatch(
    keys: string[],
    delay: number,
    ttl: number
  ): Promise<{ successCount: number; failureCount: number; timeMs: number }> {
    const startTime = Date.now();
    let successCount = 0;
    let failureCount = 0;

    // Load data for all keys in batch (simulates fetching from source)
    const results = await simulateExpensiveOperationBatch(keys, delay);

    // Store all results in cache in parallel
    await Promise.all(
      results.map(async ({ key, data }) => {
        try {
          const fullKey = `${this.KEY_PREFIX}${key}`;
          await this.redis.setex(fullKey, ttl, JSON.stringify(data));
          successCount++;
        } catch (error) {
          console.error(`[Cache Warming] Failed to cache key: ${key}`, error);
          failureCount++;
        }
      })
    );

    const timeMs = Date.now() - startTime;
    return { successCount, failureCount, timeMs };
  }
}
