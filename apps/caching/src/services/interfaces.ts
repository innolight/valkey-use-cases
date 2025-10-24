/**
 * Response metadata for cache operations
 */
export interface CacheMetadata {
  key: string;
  source: 'cache' | 'computed';
  timeTaken: number; // milliseconds
  ttl?: number; // seconds remaining
}

/**
 * Standard response format for cache operations
 */
export interface CacheResponse<T> {
  data: T;
  metadata: CacheMetadata;
}

/**
 * Interface for read pattern cache services
 */
export interface IReadPatternService {
  get(key: string, delayMs?: number): Promise<CacheResponse<any>>;
  invalidate(key: string): Promise<boolean>;
}
