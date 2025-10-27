import express from 'express';
import { ValkeyClient } from '@valkey-use-cases/shared';
import { SimpleMutexLock } from './lock.simple-mutex';
import { OperationService } from './service';
import { createOperationRouter } from './routes';

const app = express();
const PORT = process.env.PORT || 3009;

app.use(express.json());

const valkeyClient = ValkeyClient.getInstance();

// Initialize distributed lock service
const lockService = new SimpleMutexLock({
  redis: valkeyClient,
  keyPrefix: 'distributed-lock:',
});

// Initialize operation service with business logic
const operationService = new OperationService({
  lockService,
  operationMinDurationMs: 10000, // 10s
  operationMaxDurationMs: 20000, // 20s
  lockTtlMs: 25000, // 25s
});

// Register routes (pure transport layer)
app.use('/api', createOperationRouter(operationService));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'distributed-lock' });
});

app.use((_req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

async function startServer() {
  try {
    await valkeyClient.ping();
    console.log('Connected to Valkey');

    app.listen(PORT, () => {
      console.log(`Distributed Lock API server running on port ${PORT}`);
      console.log(`Health check: http://localhost:${PORT}/health`);
      console.log(
        `Operations endpoint: http://localhost:${PORT}/api/operations/:resourceId`
      );
      console.log(`\nExample usage:`);
      console.log(
        `  curl -X POST http://localhost:${PORT}/api/operations/user123`
      );
    });
  } catch (error) {
    console.error('Failed to connect to Valkey:', error);
    process.exit(1);
  }
}

process.on('SIGTERM', async () => {
  console.log('[distributed-lock] SIGTERM received, shutting down gracefully');
  await ValkeyClient.disconnect();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[distributed-lock] SIGINT received, shutting down gracefully');
  await ValkeyClient.disconnect();
  process.exit(0);
});

startServer().catch(console.error);
