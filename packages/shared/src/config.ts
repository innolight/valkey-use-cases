export interface AppConfig {
  port: number;
  valkey: {
    host: string;
    port: number;
    password?: string;
    db: number;
    keyPrefix: string;
  };
}

export const getConfig = (): AppConfig => ({
  port: parseInt(process.env.PORT || '3000'),
  valkey: {
    host: process.env.VALKEY_HOST || 'localhost',
    port: parseInt(process.env.VALKEY_PORT || '6379'),
    password: process.env.VALKEY_PASSWORD,
    db: parseInt(process.env.VALKEY_DB || '0'),
    keyPrefix: process.env.VALKEY_KEY_PREFIX || '',
  },
});
