import express from 'express';
import { ValkeyClient } from '@valkey-use-cases/shared';
import readPatternsRouter from './routes/read-patterns';
import writePatternsRouter, {
  writeBehindService,
} from './routes/write-patterns';
import advancedPatternsRouter, {
  cacheWarmingService,
} from './routes/advanced-patterns';

const app = express();
const PORT = process.env.PORT || 3002;

app.use(express.json());

const valkeyClient = ValkeyClient.getInstance();

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'caching' });
});

// Mount route handlers
app.use('/api/read-patterns', readPatternsRouter);
app.use('/api/write-patterns', writePatternsRouter);
app.use('/api/advanced-patterns', advancedPatternsRouter);

app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

async function startServer() {
  try {
    await valkeyClient.ping();
    console.log('Connected to Valkey');

    // Warm cache on startup
    console.log('\n[Cache Warming] Warming cache on start-up...');
    const warmingResult = await cacheWarmingService.warmCache();
    console.log(
      `[Cache Warming] Cache warmed: ${warmingResult.metadata.successCount}/${warmingResult.metadata.totalKeys} keys in ${warmingResult.metadata.totalTimeMs}ms`
    );

    // Start scheduled warming (every 5 minutes)
    cacheWarmingService.startScheduledWarming(5 * 60 * 1000);

    app.listen(PORT, () => {
      console.log(`\nCaching API server running on port ${PORT}`);
      console.log(`Health check: http://localhost:${PORT}/health`);
      console.log(`\nRead Patterns:`);
      console.log(`  Cache-Aside:`);
      console.log(
        `    GET    http://localhost:${PORT}/api/read-patterns/cache-aside/:key?delay=1000`
      );
      console.log(
        `    DELETE http://localhost:${PORT}/api/read-patterns/cache-aside/:key`
      );
      console.log(`  Read-Through:`);
      console.log(
        `    GET    http://localhost:${PORT}/api/read-patterns/read-through/:key?delay=1000`
      );
      console.log(
        `    DELETE http://localhost:${PORT}/api/read-patterns/read-through/:key`
      );
      console.log(`\nWrite Patterns:`);
      console.log(`  Write-Through:`);
      console.log(
        `    POST   http://localhost:${PORT}/api/write-patterns/write-through/:key`
      );
      console.log(
        `    GET    http://localhost:${PORT}/api/write-patterns/write-through/:key`
      );
      console.log(`  Write-Behind:`);
      console.log(
        `    POST   http://localhost:${PORT}/api/write-patterns/write-behind/:key`
      );
      console.log(
        `    GET    http://localhost:${PORT}/api/write-patterns/write-behind/:key`
      );
      console.log(
        `    GET    http://localhost:${PORT}/api/write-patterns/write-behind-queue/stats`
      );
      console.log(`\nAdvanced Patterns:`);
      console.log(`  Cache Warming:`);
      console.log(
        `    POST   http://localhost:${PORT}/api/advanced-patterns/cache-warming`
      );
      console.log(
        `    GET    http://localhost:${PORT}/api/advanced-patterns/cache-warming/:key`
      );
      console.log(`  Refresh-Ahead:`);
      console.log(
        `    GET    http://localhost:${PORT}/api/advanced-patterns/refresh-ahead/:key`
      );
      console.log(
        `    GET    http://localhost:${PORT}/api/advanced-patterns/refresh-ahead/:key/status`
      );
      console.log(
        `    DELETE http://localhost:${PORT}/api/advanced-patterns/refresh-ahead/:key`
      );
      console.log(`  Stampede Prevention:`);
      console.log(
        `    GET    http://localhost:${PORT}/api/advanced-patterns/stampede-prevention/:key`
      );
      console.log(
        `    DELETE http://localhost:${PORT}/api/advanced-patterns/stampede-prevention/:key`
      );
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  cacheWarmingService.stopScheduledWarming();
  await writeBehindService.destroy();
  await ValkeyClient.disconnect();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully');
  cacheWarmingService.stopScheduledWarming();
  await writeBehindService.destroy();
  await ValkeyClient.disconnect();
  process.exit(0);
});

startServer().catch(console.error);
