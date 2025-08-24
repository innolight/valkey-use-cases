import Redis from 'ioredis';
import { RateLimiter, RateLimitResult } from '../models';

interface SlidingWindowRateLimiterOptions {
  redis: Redis;
  windowMs: number;
  maxRequests: number;
}

export class SlidingWindowRateLimiter implements RateLimiter {
  private redis: Redis;
  private windowMs: number;
  private reqLimit: number;

  constructor(options: SlidingWindowRateLimiterOptions) {
    this.redis = options.redis;
    this.windowMs = options.windowMs;
    this.reqLimit = options.maxRequests;
  }

  async acquirePermit(key: string): Promise<RateLimitResult> {
    const windowMs = this.windowMs;
    const reqLimit = this.reqLimit;
    const now = Date.now();
    const windowStart = now - windowMs;

    const res = await this.redis.pipeline()
      .zremrangebyscore(key, 0, windowStart) // Remove expired requests (outside of the window)
      .zcard(key) // Get the current count of requests in the window
      .exec();

    if (!res) {
      throw new Error('Redis pipeline execution failed');
    }

    const currentCount = res[1][1] as number;

    if (currentCount >= reqLimit) {
      return {
        allowed: false,
        remainingRequests: 0,
        retryAfterSeconds: Math.ceil(windowMs / 1000),
        requestLimit: reqLimit
      };
    }

    await this.redis.pipeline()
      // Add the current request to the sliding window
      //    now is the sorting score
      //    set value has The random suffix prevents collisions when multiple requests arrive at the same millisecond
      .zadd(key, now, `${now}${Math.floor(Math.random() * 1000)}`) 
      .expire(key, Math.ceil(windowMs / 1000)) // Set the expiration for the sliding window
      .exec();

    return {
      allowed: true,
      remainingRequests: Math.max(0, reqLimit - currentCount - 1),
      retryAfterSeconds: Math.ceil(windowMs / 1000),
      requestLimit: reqLimit
    };
  }
}