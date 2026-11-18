import { readFileSync } from 'node:fs';
import { Pool, type PoolConfig } from 'pg';
import type { AppConfig } from '../config/env.js';
import type { Logger } from '../shared/logger.js';

export type DatabaseStatus = 'up' | 'down' | 'not_configured';
export interface Database {
  pool: Pool | undefined;
  check: () => Promise<DatabaseStatus>;
  close: () => Promise<void>;
}

export function createDatabase(config: AppConfig, log: Logger): Database {
  if (!config.DATABASE_URL) {
    return { pool: undefined, check: async () => 'not_configured', close: async () => {} };
  }
  const pool = new Pool(connectionSettings(config, config.DATABASE_URL));
  // Idle pooled connections can emit errors outside an HTTP request.
  pool.on('error', () => log('database.pool_error'));
  return {
    pool,
    async check() {
      try {
        await pool.query('SELECT 1');
        return 'up';
      } catch {
        log('database.check_failed');
        return 'down';
      }
    },
    close: () => pool.end(),
  };
}

export function connectionSettings(config: AppConfig, connectionString: string): PoolConfig {
  const settings: PoolConfig = {
    connectionString,
    application_name: 'streeteye-backend',
    max: config.DB_POOL_MAX,
    connectionTimeoutMillis: config.DB_TIMEOUT_MS,
    query_timeout: config.DB_TIMEOUT_MS,
    idleTimeoutMillis: 30000,
    ssl: config.DB_SSL === 'disable' ? false : { rejectUnauthorized: true },
  };
  if (config.DB_SSL === 'verify-full' && config.DB_SSL_CA_PATH) {
    settings.ssl = { rejectUnauthorized: true, ca: readFileSync(config.DB_SSL_CA_PATH, 'utf8') };
  }
  return settings;
}
