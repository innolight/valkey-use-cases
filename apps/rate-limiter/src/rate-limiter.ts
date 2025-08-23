import { Request, Response, NextFunction } from 'express';
import Redis from 'ioredis';

export interface RateLimiterOptions {
  windowMs: number;
  maxRequests: number;
  keyGenerator?: (req: Request) => string;
  skipSuccessfulRequests?: boolean;
  skipFailedRequests?: boolean;
}

export class RateLimiter {
  private redis: Redis;
  private options: Required<RateLimiterOptions>;

  constructor(redis: Redis, options: RateLimiterOptions) {
    this.redis = redis;
    this.options = {
      keyGenerator: (req: Request) => req.ip || req.connection.remoteAddress || 'unknown',
      skipSuccessfulRequests: false,
      skipFailedRequests: false,
      ...options
    };
  }

  middleware() {
    return async (req: Request, res: Response, next: NextFunction) => {
      const key = `rate_limit:${this.options.keyGenerator(req)}`;
      const now = Date.now();
      const windowStart = now - this.options.windowMs;

      try {
        // First, clean up expired requests and check current count
        const pipeline1 = this.redis.pipeline();
        pipeline1.zremrangebyscore(key, 0, windowStart);
        pipeline1.zcard(key);
        
        const results1 = await pipeline1.exec();
        
        if (!results1) {
          throw new Error('Redis pipeline execution failed');
        }

        const currentCount = results1[1][1] as number;

        // Check if we've exceeded the rate limit
        if (currentCount >= this.options.maxRequests) {
          res.status(429).json({
            error: 'Too Many Requests',
            message: 'Rate limit exceeded',
            retryAfter: Math.ceil(this.options.windowMs / 1000)
          });
          return;
        }

        // Only add the current request if we're under the limit
        const pipeline2 = this.redis.pipeline();
        pipeline2.zadd(key, now, `${now}-${Math.random()}`);
        pipeline2.expire(key, Math.ceil(this.options.windowMs / 1000));
        
        await pipeline2.exec();

        res.set({
          'X-RateLimit-Limit': this.options.maxRequests.toString(),
          'X-RateLimit-Remaining': Math.max(0, this.options.maxRequests - currentCount - 1).toString(),
          'X-RateLimit-Reset': new Date(now + this.options.windowMs).toISOString()
        });

        next();
      } catch (error) {
        console.error('Rate limiter error:', error);
        next();
      }
    };
  }
}