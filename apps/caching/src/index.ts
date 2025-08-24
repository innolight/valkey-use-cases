import express from 'express';
import { ValkeyClient } from '@valkey-use-cases/shared';

const app = express();
const PORT = process.env.PORT || 3002;

app.use(express.json());

const valkeyClient = ValkeyClient.getInstance();

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'caching' });
});

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
      console.log(`Cache operations: http://localhost:${PORT}/api/cache/{key}`);
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
