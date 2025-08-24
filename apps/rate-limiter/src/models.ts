export interface RateLimiter {
  acquirePermit(key: string): Promise<RateLimitResult>;
}

/**
 * Result of a rate limit check operation
 */
export interface RateLimitResult {
  /** Whether the request is allowed (true) or rate limited (false) */
  allowed: boolean;

  /** Number of requests remaining in the current window. 0 when rate limited. */
  remainingRequests: number;

  /** Number of seconds to wait before retrying. Only relevant when allowed is false. */
  retryAfterSeconds: number;

  /** Maximum number of requests allowed in the current window */
  requestLimit: number;
}
