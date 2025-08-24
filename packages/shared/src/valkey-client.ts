import Redis from 'ioredis';

export interface ValkeyConfig {
  host?: string;
  port?: number;
  password?: string;
  db?: number;
  keyPrefix?: string;
}

export class ValkeyClient {
  private static instance: Redis;

  static getInstance(config?: ValkeyConfig): Redis {
    if (!ValkeyClient.instance) {
      ValkeyClient.instance = new Redis({
        host: config?.host || process.env.VALKEY_HOST || 'localhost',
        port: config?.port || parseInt(process.env.VALKEY_PORT || '6379'),
        password: config?.password || process.env.VALKEY_PASSWORD,
        db: config?.db || parseInt(process.env.VALKEY_DB || '0'),
        keyPrefix: config?.keyPrefix || process.env.VALKEY_KEY_PREFIX || '',
        maxRetriesPerRequest: 3,
      });
    }
    return ValkeyClient.instance;
  }

  static async disconnect(): Promise<void> {
    if (ValkeyClient.instance) {
      await ValkeyClient.instance.quit();
    }
  }
}
