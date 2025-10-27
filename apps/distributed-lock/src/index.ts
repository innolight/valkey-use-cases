import express from 'express';
import Redis from 'ioredis';
import { ValkeyClient } from '@valkey-use-cases/shared';
import { SimpleMutexLock } from './lock.simple-mutex';
import { RedLock } from './lock.redlock';
import { OperationService } from './service';
import { createOperationRouter as createRouter } from './routes';

const app = express();
const PORT = process.env.PORT || 3009;

app.use(express.json());

const valkeyClient = ValkeyClient.getInstance();

// ============================================================================
// REDLOCK (Multi-Instance)
// ============================================================================
// High-availability lock using majority consensus across multiple instances
// Good for: critical operations (financial, inventory, etc.)
// Safe during: single-instance failures
//
// For production, configure 5 independent Redis instances:
// - redisInstance1.host/port
// - redisInstance2.host/port
// - redisInstance3.host/port
// - redisInstance4.host/port
// - redisInstance5.host/port
//
// For development/demo, we'll use the same instance on different DBs
// (NOT recommended for production - this is just for testing the API)
const redisInstances = [
  new Redis({ host: 'localhost', port: 6379, db: 0 }),
  new Redis({ host: 'localhost', port: 6379, db: 1 }),
  new Redis({ host: 'localhost', port: 6379, db: 2 }),
  new Redis({ host: 'localhost', port: 6379, db: 3 }),
  new Redis({ host: 'localhost', port: 6379, db: 4 }),
];

const redLock = new RedLock({
  redisInstances,
  keyPrefix: 'lock:red:',
  retryCount: 3,
  retryDelay: 200,
  retryJitter: 200,
  driftFactor: 0.01,
});

// ============================================================================
// ROUTES
// ============================================================================
// Register routes for both lock implementations
app.use(
  '/api/locks/simple',
  createRouter(
    new OperationService({
      // Simple fail-fast lock for basic use cases
      // Good for: short operations, acceptable to skip if locked
      // Not safe during: Redis failover scenarios
      lockService: new SimpleMutexLock({
        redis: valkeyClient,
        keyPrefix: 'lock:simple:',
      }),
      operationMinDurationMs: 10000, // 10s
      operationMaxDurationMs: 20000, // 20s
      lockDurationMs: 25000, // 25s
    })
  )
);
app.use(
  '/api/locks/redlock',
  createRouter(
    new OperationService({
      lockService: redLock,
      operationMinDurationMs: 10000, // 10s
      operationMaxDurationMs: 20000, // 20s
      lockDurationMs: 25000, // 25s
    })
  )
);

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'distributed-lock',
    implementations: {
      simpleMutex: {
        endpoint: '/api/locks/simple/:resourceId',
        type: 'Single-instance fail-fast',
      },
      redlock: {
        endpoint: '/api/locks/redlock/:resourceId',
        type: 'Multi-instance consensus',
      },
    },
  });
});

app.use((_req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

async function startServer() {
  try {
    await valkeyClient.ping();
    console.log('Connected to Valkey');

    // Ping all Redlock instances
    await Promise.all(
      redisInstances.map((instance, i) =>
        instance
          .ping()
          .then(() => console.log(`  Redlock instance ${i + 1}: connected`))
      )
    );

    app.listen(PORT, () => {
      console.log(`\n${'='.repeat(70)}`);
      console.log(`Distributed Lock API server running on port ${PORT}`);
      console.log(`${'='.repeat(70)}\n`);

      console.log(`Health check: http://localhost:${PORT}/health\n`);

      console.log('Available Lock Implementations:\n');

      console.log('1. SIMPLE MUTEX (Single-Instance)');
      console.log(
        `   Endpoint: POST http://localhost:${PORT}/api/locks/simple/:resourceId`
      );
      console.log(
        '   Use for: Fast fail-fast locking, non-critical operations'
      );
      console.log('   Example:');
      console.log(
        `     curl -X POST http://localhost:${PORT}/api/locks/simple/resource1\n`
      );

      console.log('2. REDLOCK (Multi-Instance Consensus)');
      console.log(
        `   Endpoint: POST http://localhost:${PORT}/api/locks/redlock/:resourceId`
      );
      console.log(
        '   Use for: Critical operations requiring high availability'
      );
      console.log('   Example:');
      console.log(
        `     curl -X POST http://localhost:${PORT}/api/locks/redlock/critical-resource\n`
      );

      console.log(`${'='.repeat(70)}`);
    });
  } catch (error) {
    console.error('Failed to connect to Valkey:', error);
    process.exit(1);
  }
}

async function shutdown() {
  console.log('\n[distributed-lock] Shutting down gracefully...');

  // Shutdown Redlock (releases all locks)
  await redLock.shutdown();

  // Disconnect all Redis instances
  await Promise.all(
    redisInstances.map(instance => instance.quit().catch(console.error))
  );

  // Disconnect main Valkey client
  await ValkeyClient.disconnect();

  console.log('[distributed-lock] Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

startServer().catch(console.error);
