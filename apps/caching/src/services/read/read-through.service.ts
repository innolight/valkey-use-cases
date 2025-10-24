import type { Redis } from 'ioredis';
import { IReadPatternService, CacheResponse } from '../interfaces';
import { simulateExpensiveOperation } from '../../utils/expensive-operation';

type DataLoader<T = any> = (key: string, context?: any) => Promise<T>;

interface ReadThroughCacheOptions {
  /** Default TTL in seconds for cached entries */
  ttl?: number;
  /** Key prefix for namespacing */
  keyPrefix?: string;
}

/**
 * Read-Through Cache Implementation
 *
 * This is a self-contained cache that knows how to load data from the source.
 * The application doesn't need to know about cache misses or data loading -
 * it just asks the cache for data, and the cache handles everything.
 *
 * Key architectural principle:
 * - The cache is responsible for loading data, not the application
 * - Application code is decoupled from the data source
 * - Cache provides a consistent interface regardless of hit/miss
 */
class ReadThroughCache<T = any> {
  private readonly ttl: number;
  private readonly keyPrefix: string;

  constructor(
    private readonly redis: Redis,
    private readonly dataLoader: DataLoader<T>,
    options: ReadThroughCacheOptions = {}
  ) {
    this.ttl = options.ttl ?? 3600; // Default: 1 hour
    this.keyPrefix = options.keyPrefix ?? 'read-through';
  }

  async get(key: string, context?: any): Promise<T> {
    const fullKey = this.buildKey(key);
    const cached = await this.redis.get(fullKey);

    if (cached !== null) {
      return JSON.parse(cached);
    }

    return this.loadAndCache(key, context);
  }

  async getWithMetadata(
    key: string,
    context?: any
  ): Promise<{
    data: T;
    source: 'cache' | 'computed';
    ttl?: number;
  }> {
    const fullKey = this.buildKey(key);
    const cached = await this.redis.get(fullKey);

    if (cached !== null) {
      const ttl = await this.redis.ttl(fullKey);
      return {
        data: JSON.parse(cached),
        source: 'cache',
        ttl: ttl > 0 ? ttl : undefined,
      };
    }

    const data = await this.loadAndCache(key, context);
    return {
      data,
      source: 'computed',
      ttl: this.ttl,
    };
  }

  async invalidate(key: string): Promise<boolean> {
    const fullKey = this.buildKey(key);
    const deleted = await this.redis.del(fullKey);
    return deleted > 0;
  }

  private async loadAndCache(key: string, context?: any): Promise<T> {
    const fullKey = this.buildKey(key);
    const data = await this.dataLoader(key, context);
    await this.redis.set(fullKey, JSON.stringify(data), 'EX', this.ttl);
    return data;
  }

  private buildKey(key: string): string {
    return `${this.keyPrefix}:${key}`;
  }
}

/**
 * Read-Through Pattern Service
 *
 * A THIN wrapper around ReadThroughCache.
 * The service just delegates to the cache - all loading logic is in the cache layer.
 *
 * Architecture:
 * - Service: Thin adapter to IReadPatternService interface
 * - Cache: Smart component that knows how to load data
 * - Application: Only talks to service, unaware of cache internals
 *
 * Redis Commands: GET, SET with EX (expiration), DEL, TTL
 */
export class ReadThroughService implements IReadPatternService {
  private readonly cache: ReadThroughCache;

  constructor(redis: Redis) {
    // Create a cache that knows how to load data
    // The data loader accepts a context parameter for the delay (demo purposes only)
    this.cache = new ReadThroughCache(
      redis,
      async (key: string, context?: { delayMs?: number }) =>
        simulateExpensiveOperation(key, context?.delayMs ?? 1000),
      { ttl: 3600, keyPrefix: 'read-through' }
    );
  }

  async get(key: string, delayMs = 1000): Promise<CacheResponse<any>> {
    const startTime = Date.now();

    // Simply delegate to cache - no tempCache hack!
    // Pass delayMs as context (for demo purposes only)
    const result = await this.cache.getWithMetadata(key, { delayMs });
    const timeTaken = Date.now() - startTime;

    return {
      data: result.data,
      metadata: {
        key,
        source: result.source,
        timeTaken,
        ttl: result.ttl,
      },
    };
  }

  async invalidate(key: string): Promise<boolean> {
    return this.cache.invalidate(key);
  }
}
