export interface CacheMetadata {
  key: string;
  source: 'cache' | 'computed';
  timeTaken: number; // milliseconds
  ttl?: number; // seconds remaining
}

export interface CacheResponse<T> {
  data: T;
  metadata: CacheMetadata;
}

export interface IReadPatternService {
  /**
   * Get data by key, either from cache or by loading from source
   *
   * @param key - The cache key to retrieve
   * @param delayMs - Optional simulated delay for expensive operations (for demo purposes)
   * @returns Promise resolving to CacheResponse with data and metadata
   */
  get(key: string, delayMs?: number): Promise<CacheResponse<any>>;

  /**
   * Invalidate (delete) a cache entry
   * @returns Promise resolving to true if key was deleted, false if key didn't exist
   */
  invalidate(key: string): Promise<boolean>;
}
