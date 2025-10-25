import { Router, Request, Response } from 'express';
import { CacheWarmingService } from '../services/advanced/cache-warming.service';
import { ValkeyClient } from '@valkey-use-cases/shared';

const router: Router = Router();
const redis = ValkeyClient.getInstance();

// Initialize cache warming service
export const cacheWarmingService = new CacheWarmingService(redis);

/**
 * POST /api/advanced-patterns/cache-warming
 * Trigger cache warming with optional configuration
 *
 * Request body (all optional):
 * {
 *   keys?: string[],        // Specific keys to warm (default: getCacheKeysToWarm())
 *   concurrency?: number,   // Batch size (default: 10)
 *   ttl?: number,          // Cache TTL in seconds (default: 3600)
 *   delay?: number         // Simulated operation delay in ms (default: 1000)
 * }
 */
router.post('/cache-warming', async (req: Request, res: Response) => {
  try {
    const options = req.body;

    // Validate options if provided
    if (options.concurrency !== undefined && options.concurrency < 1) {
      return res.status(400).json({
        error: 'Invalid concurrency',
        message: 'Concurrency must be at least 1',
      });
    }

    if (options.ttl !== undefined && options.ttl < 1) {
      return res.status(400).json({
        error: 'Invalid TTL',
        message: 'TTL must be at least 1 second',
      });
    }

    const result = await cacheWarmingService.warmCache(options);

    res.json(result);
  } catch (error) {
    console.error('Cache warming error:', error);
    res.status(500).json({
      error: 'Failed to warm cache',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/advanced-patterns/cache-warming/:key
 * Read a warmed cache entry to verify it was loaded
 *
 * Returns 200 with data if found, 404 if not found
 */
router.get('/cache-warming/:key', async (req: Request, res: Response) => {
  try {
    const { key } = req.params;
    const result = await cacheWarmingService.get(key);

    if (!result) {
      return res.status(404).json({
        data: null,
        metadata: {
          key,
          source: 'not_found',
          timeTaken: 1,
          message:
            'Key not found in warmed cache. Cache warming is proactive - keys must be explicitly warmed.',
        },
      });
    }

    res.json(result);
  } catch (error) {
    console.error('Cache warming GET error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
