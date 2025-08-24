import express from 'express';
import { ValkeyClient } from '@valkey-use-cases/shared';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());

const valkeyClient = ValkeyClient.getInstance();

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'analytics' });
});

app.use((_req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

async function startServer() {
  try {
    await valkeyClient.ping();
    console.log('Connected to Valkey');

    app.listen(PORT, () => {
      console.log(`Analytics API server running on port ${PORT}`);
      console.log(`Health check: http://localhost:${PORT}/health`);
      console.log(`Record event: POST http://localhost:${PORT}/api/events`);
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
