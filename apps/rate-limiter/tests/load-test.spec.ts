import request from 'supertest';
import express from 'express';
import { ValkeyClient } from '@valkey-use-cases/shared';
import { SlidingWindowRateLimiter } from '../src/valkey/sliding-window-rate-limiter';
import { createRateLimitMiddleware, IpAddressKeyGenerator } from '../src/middleware';

describe('Rate Limiter Load Test Verification', () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use(express.json());

    const valkeyClient = ValkeyClient.getInstance();
    const rateLimiter = new SlidingWindowRateLimiter({
      redis: valkeyClient,
      windowMs: 1000,
      maxRequests: 2
    });
    const rateLimitMiddleware = createRateLimitMiddleware(rateLimiter, IpAddressKeyGenerator);

    app.get('/api/test', rateLimitMiddleware, (req, res) => {
      res.json({ success: true, timestamp: Date.now() });
    });
  });

  beforeEach(async () => {
    // Clean up rate limiting keys
    const redis = ValkeyClient.getInstance();
    const keys = await redis.keys('rate_limit:*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  });

  afterAll(async () => {
    await ValkeyClient.disconnect();
  });

  test('simulates 3 RPS load with 2 RPS limit - sequential requests', async () => {
    const results: Array<{status: number, success: boolean, time: number}> = [];
    const startTime = Date.now();
    
    // Simulate 9 requests over 3 seconds (3 RPS)
    for (let second = 0; second < 3; second++) {
      for (let req = 0; req < 3; req++) {
        try {
          const response = await request(app).get('/api/test');
          results.push({
            status: response.status,
            success: response.status === 200,
            time: Date.now() - startTime
          });
        } catch (error) {
          results.push({
            status: 500,
            success: false,
            time: Date.now() - startTime
          });
        }
        
        // Small delay between requests in same second
        if (req < 2) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }
      
      // Wait for next second
      if (second < 2) {
        await new Promise(resolve => setTimeout(resolve, 950));
      }
    }

    // Analyze results
    const successful = results.filter(r => r.success).length;
    const rateLimited = results.filter(r => r.status === 429).length;
    const successRate = (successful / results.length) * 100;

    console.log(`Results: ${successful} success, ${rateLimited} rate limited, ${successRate.toFixed(1)}% success rate`);

    // Should have ~6 successful requests (2 per second) out of 9 total
    expect(successful).toBeGreaterThanOrEqual(5);
    expect(successful).toBeLessThanOrEqual(7);
    expect(rateLimited).toBeGreaterThan(2);
    expect(successRate).toBeGreaterThan(50);
    expect(successRate).toBeLessThan(80);
  }, 10000);
});