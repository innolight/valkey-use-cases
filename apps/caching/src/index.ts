import express from 'express';
import { ValkeyClient } from '@valkey-use-cases/shared';
import readPatternsRouter from './routes/read-patterns';

const app = express();
const PORT = process.env.PORT || 3002;

app.use(express.json());

const valkeyClient = ValkeyClient.getInstance();

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'caching' });
});

// Mount route handlers
app.use('/api/read-patterns', readPatternsRouter);

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
      console.log(`\nCache-Aside Pattern:`);
      console.log(`  GET    http://localhost:${PORT}/api/read-patterns/cache-aside/:key?delay=1000`);
      console.log(`  DELETE http://localhost:${PORT}/api/read-patterns/cache-aside/:key`);
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
