import Redis from 'ioredis';
import {
  IWritePatternService,
  WriteResponse,
  CacheResponse,
} from '../interfaces';

/**
 * Write-Behind (Write-Back) Pattern
 *
 * Writes go to cache immediately and return fast. The write to the source
 * happens asynchronously in the background via a reliable queue.
 *
 * Flow:
 * 1. Write to cache immediately (SET key value)
 * 2. Add write to reliable queue (XADD write-queue * key value)
 * 3. Return success to application (fast!)
 * 4. Background worker processes queue (XREADGROUP)
 * 5. Worker writes to source asynchronously
 * 6. Acknowledge message (XACK)
 *
 * Trade-offs:
 * ✅ Fastest write performance
 * ✅ Reduced load on source database
 * ✅ Can batch writes for efficiency
 * ❌ Risk of data loss if cache crashes before write completes
 * ❌ Temporary inconsistency between cache and source
 * ❌ Complex error handling and monitoring needed
 */
export class WriteBehindService implements IWritePatternService {
  private redis: Redis;
  private readonly QUEUE_NAME = 'write-behind:queue';
  private readonly GROUP_NAME = 'write-behind:workers';
  private readonly CONSUMER_NAME = `worker-${process.pid}`;
  private readonly DEFAULT_TTL = 3600; // 1 hour in seconds
  private workerInterval: NodeJS.Timeout | null = null;
  private isProcessing = false;

  constructor(redisClient: Redis) {
    this.redis = redisClient;
    this.initializeWorker();
  }

  /**
   * Initialize the background worker that processes the write queue
   */
  private async initializeWorker(): Promise<void> {
    try {
      // Create consumer group if it doesn't exist
      try {
        await this.redis.xgroup(
          'CREATE',
          this.QUEUE_NAME,
          this.GROUP_NAME,
          '0',
          'MKSTREAM'
        );
        console.log(
          `[Write-Behind] Consumer group created: ${this.GROUP_NAME}`
        );
      } catch (error: any) {
        // Group already exists, which is fine
        if (!error.message?.includes('BUSYGROUP')) {
          throw error;
        }
      }

      // Start background worker that processes queue every 5 seconds
      this.workerInterval = setInterval(() => {
        this.processQueue();
      }, 5000);

      console.log('[Write-Behind] Background worker started');
    } catch (error) {
      console.error('[Write-Behind] Failed to initialize worker:', error);
      throw error;
    }
  }

  /**
   * Process pending writes from the queue
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing) {
      return; // Prevent concurrent processing
    }

    this.isProcessing = true;

    try {
      // Read messages from the queue using ioredis syntax
      // XREADGROUP GROUP group consumer [COUNT count] [BLOCK milliseconds] STREAMS key [key ...] ID [ID ...]
      const messages = await this.redis.xreadgroup(
        'GROUP',
        this.GROUP_NAME,
        this.CONSUMER_NAME, // unique identifier of a consumer within the group; multiple workers have different names
        'COUNT',
        10, // process up to 10 messages at a time
        'BLOCK',
        100, // wait up to 100ms if no messages are available
        'STREAMS',
        this.QUEUE_NAME,
        '>' // read only new messages that have never been delivered to this group
      );

      if (!messages || messages.length === 0) {
        this.isProcessing = false;
        return;
      }

      // Process each message
      // ioredis returns: [[stream_name, [[id, [field1, value1, field2, value2, ...]]]]
      for (const [streamName, streamMessages] of messages as any[]) {
        for (const [messageId, fields] of streamMessages as any[]) {
          try {
            // Convert flat array [field1, value1, field2, value2] to object
            const message: any = {};
            for (let i = 0; i < fields.length; i += 2) {
              message[fields[i]] = fields[i + 1];
            }

            await this.processMessage(messageId, message);

            // Acknowledge successful processing
            await this.redis.xack(this.QUEUE_NAME, this.GROUP_NAME, messageId);
          } catch (error) {
            console.error(
              `[Write-Behind] Failed to process message ${messageId}:`,
              error
            );
            // In production, you might want to:
            // - Retry with exponential backoff
            // - Move to dead letter queue after max retries
            // - Alert monitoring systems
          }
        }
      }
    } catch (error) {
      console.error('[Write-Behind] Error processing queue:', error);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Process a single message from the queue
   * In production, this would write to the actual database
   */
  private async processMessage(messageId: string, data: any): Promise<void> {
    const key = data.key;
    const value = data.value;

    console.log(`[Write-Behind] Processing write for key: ${key}`);

    // Simulate database write with delay
    await new Promise(resolve => setTimeout(resolve, 100));

    // In production, this would be:
    // await database.update(key, JSON.parse(value));
    console.log(`[Write-Behind] Successfully wrote to database: ${key}`);
  }

  /**
   * Write data to cache immediately and queue for background persistence
   */
  async write(
    key: string,
    value: any,
    delayMs?: number
  ): Promise<WriteResponse> {
    const startTime = Date.now();
    const cacheKey = `write-behind:${key}`;

    try {
      const serializedValue = JSON.stringify(value);

      // Step 1: Write to cache immediately with TTL (fast!)
      await this.redis.set(cacheKey, serializedValue, 'EX', this.DEFAULT_TTL);

      // Step 2: Add write operation to queue for background processing
      // XADD stream * field1 value1 field2 value2 ...
      await this.redis.xadd(
        this.QUEUE_NAME,
        '*', // Auto-generated ID
        'key',
        key,
        'value',
        serializedValue,
        'timestamp',
        Date.now().toString()
      );

      const timeTaken = Date.now() - startTime;
      console.log(
        `[Write-Behind] Write completed in ${timeTaken}ms (queued for persistence)`
      );

      // Note: We return immediately without waiting for database write
      // This makes writes very fast but introduces eventual consistency
      return {
        success: true,
        metadata: {
          key,
          timeTaken,
          writtenToCache: true,
          writtenToSource: false, // Source write is queued, not yet completed
        },
      };
    } catch (error) {
      console.error('[Write-Behind] Write failed:', error);
      throw error;
    }
  }

  /**
   * Read data from cache
   */
  async read(key: string): Promise<CacheResponse<any>> {
    const startTime = Date.now();
    const cacheKey = `write-behind:${key}`;

    try {
      const cached = await this.redis.get(cacheKey);

      if (!cached) {
        return {
          data: null,
          metadata: {
            key,
            source: 'cache',
            timeTaken: Date.now() - startTime,
          },
        };
      }

      return {
        data: JSON.parse(cached),
        metadata: {
          key,
          source: 'cache',
          timeTaken: Date.now() - startTime,
        },
      };
    } catch (error) {
      console.error('[Write-Behind] Read failed:', error);
      throw error;
    }
  }

  /**
   * Get queue statistics for monitoring
   */
  async getQueueStats(): Promise<{
    totalPendingMessages: number;
    totalStreamLength: number;
    activeConsumers: number;
    oldestPendingMs?: number;
  }> {
    try {
      // Get pending messages summary: [count, min-id, max-id, [[consumer, pending-count]]]
      const pendingSummary: any = await this.redis.xpending(
        this.QUEUE_NAME,
        this.GROUP_NAME
      );

      // Get stream info using ioredis
      const streamInfo: any = await this.redis.xinfo('STREAM', this.QUEUE_NAME);

      // Parse streamInfo array into object
      const streamObj: any = {};
      for (let i = 0; i < streamInfo.length; i += 2) {
        streamObj[streamInfo[i]] = streamInfo[i + 1];
      }

      // Get consumer group details to count active consumers
      const groupInfo: any = await this.redis.xinfo('GROUPS', this.QUEUE_NAME);

      let activeConsumers = 0;
      if (Array.isArray(groupInfo) && groupInfo.length > 0) {
        // groupInfo is an array of arrays, each representing a group
        for (const group of groupInfo) {
          const groupObj: any = {};
          for (let i = 0; i < group.length; i += 2) {
            groupObj[group[i]] = group[i + 1];
          }
          if (groupObj.name === this.GROUP_NAME) {
            activeConsumers = groupObj.consumers || 0;
            break;
          }
        }
      }

      const pendingCount =
        Array.isArray(pendingSummary) && pendingSummary.length > 0
          ? pendingSummary[0]
          : 0;

      // Calculate age of oldest pending message
      let oldestPendingMs: number | undefined;
      if (pendingCount > 0 && pendingSummary[1]) {
        const oldestId = pendingSummary[1];
        // Redis Stream ID format: timestamp-sequence
        const timestamp = parseInt(oldestId.split('-')[0]);
        oldestPendingMs = Date.now() - timestamp;
      }

      return {
        totalPendingMessages: pendingCount,
        totalStreamLength: streamObj.length || 0,
        activeConsumers,
        oldestPendingMs,
      };
    } catch (error) {
      console.error('[Write-Behind] Failed to get queue stats:', error);
      throw error;
    }
  }

  /**
   * Cleanup resources when service is destroyed
   */
  async destroy(): Promise<void> {
    if (this.workerInterval) {
      clearInterval(this.workerInterval);
      this.workerInterval = null;
    }
    console.log('[Write-Behind] Worker stopped');
  }
}
