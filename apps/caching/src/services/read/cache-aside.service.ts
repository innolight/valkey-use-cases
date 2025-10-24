import type { Redis } from 'ioredis';
import { IReadPatternService, CacheResponse } from '../interfaces';
import { simulateExpensiveOperation } from '../../utils/expensive-operation';

/**
 * Cache-Aside (Lazy Loading) Pattern Implementation
 *
 * Application code explicitly manages the cache:
 * 1. Check cache first (GET key)
 * 2. If HIT → return cached data
 * 3. If MISS → load from source, store in cache, return data
 *
 * Redis Commands: GET, SET with EX (expiration), DEL
 */
export class CacheAsideService implements IReadPatternService {
  private readonly DEFAULT_TTL = 3600; // 1 hour in seconds

  constructor(private readonly redis: Redis) {}

  async get(key: string, delayMs = 1000): Promise<CacheResponse<any>> {
    const startTime = Date.now();

    // Try cache first
    const cached = await this.redis.get(`cache-aside:${key}`);

    if (cached) {
      // Cache HIT
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

    // Cache MISS - load from source
    const data = await simulateExpensiveOperation(key, delayMs);

    // Store in cache for future requests
    await this.redis.set(
      `cache-aside:${key}`,
      JSON.stringify(data),
      'EX',
      this.DEFAULT_TTL
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

  async invalidate(key: string): Promise<boolean> {
    const deleted = await this.redis.del(`cache-aside:${key}`);
    return deleted > 0;
  }
}
