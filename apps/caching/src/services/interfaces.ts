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

export interface WriteMetadata {
  key: string;
  timeTaken: number; // milliseconds
  writtenToCache: boolean;
  writtenToSource: boolean;
}

export interface WriteResponse {
  success: boolean;
  metadata: WriteMetadata;
}

export interface IWritePatternService {
  /**
   * Write data to both cache and source
   *
   * @param key - The cache key to write
   * @param value - The value to write
   * @param delayMs - Optional simulated delay for expensive write operations (for demo purposes)
   * @returns Promise resolving to WriteResponse with metadata
   */
  write(key: string, value: any, delayMs?: number): Promise<WriteResponse>;

  /**
   * Read data from cache (writes populate cache, so reads should always hit cache)
   *
   * @param key - The cache key to read
   * @returns Promise resolving to CacheResponse with data and metadata
   */
  read(key: string): Promise<CacheResponse<any>>;
}
