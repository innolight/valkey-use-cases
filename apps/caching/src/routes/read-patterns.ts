import { Router, Request, Response } from 'express';
import { CacheAsideService } from '../services/read/cache-aside.service';
import { ReadThroughService } from '../services/read/read-through.service';
import { ValkeyClient } from '@valkey-use-cases/shared';

const router: Router = Router();
const redis = ValkeyClient.getInstance();

// Initialize services
const cacheAsideService = new CacheAsideService(redis);
const readThroughService = new ReadThroughService(redis);

/**
 * GET /api/read-patterns/cache-aside/:key
 * Get data using cache-aside pattern
 * Query params:
 *   - delay: Simulation delay in ms (default: 1000)
 */
router.get('/cache-aside/:key', async (req: Request, res: Response) => {
  try {
    const { key } = req.params;
    const delay = parseInt(req.query.delay as string) || 1000;

    const result = await cacheAsideService.get(key, delay);

    res.json(result);
  } catch (error) {
    console.error('Cache-aside GET error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * DELETE /api/read-patterns/cache-aside/:key
 * Invalidate cache entry
 */
router.delete('/cache-aside/:key', async (req: Request, res: Response) => {
  try {
    const { key } = req.params;
    const deleted = await cacheAsideService.invalidate(key);

    res.json({
      key,
      deleted,
      message: deleted ? 'Cache entry deleted' : 'Cache entry not found',
    });
  } catch (error) {
    console.error('Cache-aside DELETE error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/read-patterns/read-through/:key
 * Get data using read-through pattern
 * Query params:
 *   - delay: Simulation delay in ms (default: 1000)
 */
router.get('/read-through/:key', async (req: Request, res: Response) => {
  try {
    const { key } = req.params;
    const delay = parseInt(req.query.delay as string) || 1000;

    const result = await readThroughService.get(key, delay);

    res.json(result);
  } catch (error) {
    console.error('Read-through GET error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * DELETE /api/read-patterns/read-through/:key
 * Invalidate cache entry
 */
router.delete('/read-through/:key', async (req: Request, res: Response) => {
  try {
    const { key } = req.params;
    const deleted = await readThroughService.invalidate(key);

    res.json({
      key,
      deleted,
      message: deleted ? 'Cache entry deleted' : 'Cache entry not found',
    });
  } catch (error) {
    console.error('Read-through DELETE error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
