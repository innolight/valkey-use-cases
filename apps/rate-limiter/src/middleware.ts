import { Request, Response, NextFunction } from 'express';
import { RateLimiter } from './models';

export type RateLimitKeyGenerator = (req: Request) => string;

export const IpAddressKeyGenerator: RateLimitKeyGenerator = (req: Request) => {
  return req.socket.remoteAddress || 'unknown';
};

export function createRateLimitMiddleware(
  rateLimiter: RateLimiter,
  keyGenerator?: RateLimitKeyGenerator
) {
  const keyGen = keyGenerator || IpAddressKeyGenerator;

  return async (req: Request, res: Response, next: NextFunction) => {
    const key = `rate_limit:${keyGen(req)}`;

    try {
      const result = await rateLimiter.acquirePermit(key);

      if (!result.allowed) {
        res.status(429).json({
          error: 'Too Many Requests',
          message: 'Rate limit exceeded',
          retryAfter: result.retryAfterSeconds
        });
        return;
      }

      res.set({
        'X-RateLimit-Limit': result.requestLimit.toString(),
        'X-RateLimit-Remaining': result.remainingRequests.toString()
      });

      next();
    } catch (error) {
      console.error('Rate limiter error:', error);
      next();
    }
  };
}