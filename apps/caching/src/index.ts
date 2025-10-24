import express from 'express';
import { ValkeyClient } from '@valkey-use-cases/shared';
import readPatternsRouter from './routes/read-patterns';
import writePatternsRouter from './routes/write-patterns';

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

app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

async function startServer() {
  try {
    await valkeyClient.ping();
    console.log('Connected to Valkey');

    app.listen(PORT, () => {
      console.log(`Caching API server running on port ${PORT}`);
      console.log(`Health check: http://localhost:${PORT}/health`);
      console.log(`\nRead Patterns:`);
      console.log(`  Cache-Aside:`);
      console.log(`    GET    http://localhost:${PORT}/api/read-patterns/cache-aside/:key?delay=1000`);
      console.log(`    DELETE http://localhost:${PORT}/api/read-patterns/cache-aside/:key`);
      console.log(`  Read-Through:`);
      console.log(`    GET    http://localhost:${PORT}/api/read-patterns/read-through/:key?delay=1000`);
      console.log(`    DELETE http://localhost:${PORT}/api/read-patterns/read-through/:key`);
      console.log(`\nWrite Patterns:`);
      console.log(`  Write-Through:`);
      console.log(`    POST   http://localhost:${PORT}/api/write-patterns/write-through/:key`);
      console.log(`    GET    http://localhost:${PORT}/api/write-patterns/write-through/:key`);
      console.log(`  Write-Behind:`);
      console.log(`    POST   http://localhost:${PORT}/api/write-patterns/write-behind/:key`);
      console.log(`    GET    http://localhost:${PORT}/api/write-patterns/write-behind/:key`);
      console.log(`    GET    http://localhost:${PORT}/api/write-patterns/write-behind-queue/stats`);
    });
  } catch (error) {
    console.error('Failed to connect to Valkey:', error);
    process.exit(1);
  }
}

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  await ValkeyClient.disconnect();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully');
  await ValkeyClient.disconnect();
  process.exit(0);
});

startServer().catch(console.error);
