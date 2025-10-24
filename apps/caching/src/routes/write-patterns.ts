import { Router, Request, Response } from 'express';
import { WriteThroughService } from '../services/write/write-through.service';
import { WriteBehindService } from '../services/write/write-behind.service';
import { ValkeyClient } from '@valkey-use-cases/shared';

const router: Router = Router();
const redis = ValkeyClient.getInstance();

// Initialize services
const writeThroughService = new WriteThroughService(redis);
const writeBehindService = new WriteBehindService(redis);

/**
 * POST /api/write-patterns/write-through/:key
 * Write data using write-through pattern
 * Body:
 *   - value: any (the data to write)
 *   - delay: number (optional, simulation delay in ms, default: 1000)
 */
router.post('/write-through/:key', async (req: Request, res: Response) => {
  try {
    const { key } = req.params;
    const { value, delay } = req.body;

    if (value === undefined) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Request body must include "value" field',
      });
    }

    const delayMs = typeof delay === 'number' ? delay : 1000;

    const result = await writeThroughService.write(key, value, delayMs);

    res.json(result);
  } catch (error) {
    console.error('Write-through POST error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/write-patterns/write-through/:key
 * Read data written using write-through pattern
 */
router.get('/write-through/:key', async (req: Request, res: Response) => {
  try {
    const { key } = req.params;

    const result = await writeThroughService.read(key);

    if (result.data === null) {
      return res.status(404).json({
        error: 'Not Found',
        message: `No data found for key: ${key}`,
        metadata: result.metadata,
      });
    }

    res.json(result);
  } catch (error) {
    console.error('Write-through GET error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/write-patterns/write-behind/:key
 * Write data using write-behind pattern (fast, queued for persistence)
 * Body:
 *   - value: any (the data to write)
 */
router.post('/write-behind/:key', async (req: Request, res: Response) => {
  try {
    const { key } = req.params;
    const { value } = req.body;

    if (value === undefined) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Request body must include "value" field',
      });
    }

    const result = await writeBehindService.write(key, value);

    res.json(result);
  } catch (error) {
    console.error('Write-behind POST error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/write-patterns/write-behind/:key
 * Read data from cache (write-behind pattern)
 */
router.get('/write-behind/:key', async (req: Request, res: Response) => {
  try {
    const { key } = req.params;

    const result = await writeBehindService.read(key);

    if (result.data === null) {
      return res.status(404).json({
        error: 'Not Found',
        message: `No data found for key: ${key}`,
        metadata: result.metadata,
      });
    }

    res.json(result);
  } catch (error) {
    console.error('Write-behind GET error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/write-patterns/write-behind-queue/stats
 * Get queue statistics for monitoring
 */
router.get('/write-behind-queue/stats', async (req: Request, res: Response) => {
  try {
    const stats = await writeBehindService.getQueueStats();

    res.json({
      queue: 'write-behind',
      stats,
      description: {
        totalPendingMessages:
          'Messages delivered to consumers but not yet acknowledged (includes processing + waiting)',
        totalStreamLength:
          'Total messages in the Redis Stream (includes processed messages)',
        activeConsumers: 'Number of active consumer workers',
        oldestPendingMs:
          'Age of the oldest pending message in milliseconds (undefined if no pending messages)',
      },
    });
  } catch (error) {
    console.error('Write-behind queue stats error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
