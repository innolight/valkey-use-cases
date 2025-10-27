import { Router, Request, Response } from 'express';
import { OperationService } from './service';

/**
 * Creates Express router for operation endpoints
 *
 * This is a pure transport layer that:
 * - Handles HTTP request/response mapping
 * - Delegates all business logic to OperationService
 * - Maps service results to appropriate HTTP status codes and headers
 *
 * The router is lock-strategy agnostic - the same endpoints work with
 * any DistributedLock implementation (SimpleMutex, Redlock, etc.)
 */
export function createOperationRouter(service: OperationService): Router {
  const router = Router();

  /**
   * POST {routePrefix}/:resourceId
   *
   * Performs a mutually exclusive operation on the specified resource.
   *
   * Response codes:
   * - 200 OK: Operation completed successfully
   * - 409 Conflict: Resource is currently locked by another request
   *   - Includes Retry-After header indicating seconds to wait
   * - 500 Internal Server Error: Operation or lock management failed
   */
  router.post(
    `/:resourceId`,
    async (req: Request, res: Response): Promise<void> => {
      const { resourceId } = req.params;

      // Delegate to service layer
      const result = await service.doMutuallyExclusiveOperation(resourceId);

      if (result.success) {
        // Operation completed successfully
        res.status(200).json(result);
      } else if (result.retryAfterMs !== undefined) {
        // Resource is locked - return 409 with Retry-After header
        res.set(
          'Retry-After',
          Math.ceil(result.retryAfterMs / 1000).toString()
        );
        res.status(409).json({
          error: result.error,
          message: `Resource '${resourceId}' is being processed by another request`,
          retryAfterMs: result.retryAfterMs,
        });
      } else {
        // Operation or lock management failed
        res.status(500).json({
          error: result.error || 'Internal server error',
          message: 'Failed to complete operation',
        });
      }
    }
  );

  return router;
}
