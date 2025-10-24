import type { Redis } from 'ioredis';
import {
  IWritePatternService,
  WriteResponse,
  CacheResponse,
} from '../interfaces';
import { simulateExpensiveWrite } from '../../utils/expensive-operation';

/**
 * Write-Through Pattern Implementation
 *
 * Every write goes through the cache to the source. Both cache and source
 * are updated synchronously before the write is considered complete.
 *
 * Flow:
 * 1. Application writes data
 * 2. Write to source (database UPDATE) - synchronous, ensures durability
 * 3. Write to cache (SET key value) - for fast subsequent reads
 * 4. Both writes must succeed
 * 5. Return success to application
 *
 * Redis Commands: SET, GET, DEL
 *
 * Pros:
 * - Cache and source always consistent
 * - No cache misses on recent writes
 * - Simple consistency model
 * - Immediate durability
 *
 * Cons:
 * - Slower writes (both systems)
 * - Write penalty even if data never read
 * - Source is the bottleneck
 */
export class WriteThroughService implements IWritePatternService {
  private readonly DEFAULT_TTL = 3600; // 1 hour in seconds

  constructor(private readonly redis: Redis) {}

  async write(
    key: string,
    value: any,
    delayMs = 1000,
  ): Promise<WriteResponse> {
    const startTime = Date.now();
    const cacheKey = `write-through:${key}`;

    try {
      // Step 1: Write to source (database) FIRST - ensures durability
      // This is critical: the source of truth must be updated before the cache
      await simulateExpensiveWrite(key, value, delayMs);

      // Step 2: Write to cache (for fast subsequent reads)
      // If this fails, data is still safely persisted in the source
      await this.redis.set(
        cacheKey,
        JSON.stringify(value),
        'EX',
        this.DEFAULT_TTL,
      );

      const timeTaken = Date.now() - startTime;

      return {
        success: true,
        metadata: {
          key,
          timeTaken,
          writtenToCache: true,
          writtenToSource: true,
        },
      };
    } catch (error) {
      // If source write fails, nothing was written (good - consistent state)
      // If cache write fails after source succeeds, data is still durable
      // Future reads will just be cache misses that reload from source
      throw error;
    }
  }

  async read(key: string): Promise<CacheResponse<any>> {
    const startTime = Date.now();
    const cacheKey = `write-through:${key}`;

    const cached = await this.redis.get(cacheKey);

    if (cached) {
      const ttl = await this.redis.ttl(cacheKey);
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

    // If no cache entry exists, return null
    // In write-through, data should always be in cache after a write
    const timeTaken = Date.now() - startTime;

    return {
      data: null,
      metadata: {
        key,
        source: 'cache',
        timeTaken,
      },
    };
  }
}
