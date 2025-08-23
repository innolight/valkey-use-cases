import express from 'express';
import { ValkeyClient } from '@valkey-use-cases/shared';
import { RateLimiter } from './rate-limiter';

const app = express();
const PORT = process.env.PORT || 3003;

app.use(express.json());

const valkeyClient = ValkeyClient.getInstance();

const rateLimiter = new RateLimiter(valkeyClient, {
  windowMs: 1000,
  maxRequests: 1,
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'rate-limiter' });
});

app.get('/api/data', rateLimiter.middleware(), (req, res) => {
  res.json({
    message: 'Data retrieved successfully',
    timestamp: new Date().toISOString(),
    clientIp: req.ip
  });
});

app.get('/api/protected', rateLimiter.middleware(), (req, res) => {
  res.json({
    message: 'This endpoint is rate limited to 1 request per second',
    timestamp: new Date().toISOString(),
    data: {
      id: Math.floor(Math.random() * 1000),
      value: Math.random()
    }
  });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

async function startServer() {
  try {
    await valkeyClient.ping();
    console.log('Connected to Valkey');
    
    app.listen(PORT, () => {
      console.log(`Rate Limiter API server running on port ${PORT}`);
      console.log(`Health check: http://localhost:${PORT}/health`);
      console.log(`Protected endpoint: http://localhost:${PORT}/api/protected`);
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