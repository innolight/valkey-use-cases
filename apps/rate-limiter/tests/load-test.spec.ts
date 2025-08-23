import request from 'supertest';
import express from 'express';
import { ValkeyClient } from '@valkey-use-cases/shared';
import { RateLimiter } from '../src/rate-limiter';

describe('Rate Limiter Load Test Verification', () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use(express.json());

    const valkeyClient = ValkeyClient.getInstance();
    const rateLimiter = new RateLimiter(valkeyClient, {
      windowMs: 1000,
      maxRequests: 1,
    });

    app.get('/api/test', rateLimiter.middleware(), (req, res) => {
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

  test('simulates 3 RPS load with 1 RPS limit - sequential requests', async () => {
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

    // Should have ~3 successful requests (1 per second) out of 9 total
    expect(successful).toBeGreaterThanOrEqual(2);
    expect(successful).toBeLessThanOrEqual(4);
    expect(rateLimited).toBeGreaterThan(4);
    expect(successRate).toBeGreaterThan(20);
    expect(successRate).toBeLessThan(50);
  }, 10000);
});