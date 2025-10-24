import type { Redis } from 'ioredis';
import { IReadPatternService, CacheResponse } from '../interfaces';
import { simulateExpensiveOperation } from '../../utils/expensive-operation';

/**
 * Cache-Aside (Lazy Loading) Pattern Implementation
 *
 * The most common caching pattern where the application code explicitly manages the cache:
 * 1. Application requests data by key
 * 2. Check cache first (GET key)
 * 3a. Cache HIT → Return cached data immediately
 * 3b. Cache MISS → Load from source (database/API)
 * 4. Store in cache (SET key value)
 * 5. Return data to application
 *
 * Use when:
 * - Data is read more frequently than written
 * - Cache misses are acceptable (occasional slow requests)
 * - You need full control over caching logic
 * - Different data has different caching requirements
 */
export class CacheAsideService implements IReadPatternService {
  private readonly DEFAULT_TTL = 3600; // 1 hour in seconds

  constructor(private readonly redis: Redis) {}

  /**
   * Get data using cache-aside pattern
   * @param key - Cache key
   * @param delayMs - Simulated delay for expensive operation (default: 1000ms)
   * @returns Cache response with data and metadata
   */
  async get(key: string, delayMs = 1000): Promise<CacheResponse<any>> {
    const startTime = Date.now();

    // Step 1: Try cache first
    const cached = await this.redis.get(`cache-aside:${key}`);

    if (cached) {
      // Cache HIT - return immediately
      const ttl = await this.redis.ttl(`cache-aside:${key}`);
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

    // Step 2: Cache MISS - load from source
    const data = await simulateExpensiveOperation(key, delayMs);

    // Step 3: Store in cache for future requests
    await this.redis.set(
      `cache-aside:${key}`,
      JSON.stringify(data),
      'EX',
      this.DEFAULT_TTL,
    );

    const timeTaken = Date.now() - startTime;

    return {
      data,
      metadata: {
        key,
        source: 'computed',
        timeTaken,
        ttl: this.DEFAULT_TTL,
      },
    };
  }

  /**
   * Invalidate cache entry
   * @param key - Cache key to invalidate
   * @returns true if key was deleted, false if key didn't exist
   */
  async invalidate(key: string): Promise<boolean> {
    const deleted = await this.redis.del(`cache-aside:${key}`);
    return deleted > 0;
  }
}
