import { readFileSync } from 'node:fs';
import type { PoolConfig } from 'pg';
export interface AppConfig {
  database: PoolConfig; origin: string; secret: string; secure: boolean; idleMs: number; absoluteMs: number;
  trustProxy: number; port: number; staticDir?: string;
}
function secret(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const file = env[name + '_FILE'];
  return file ? readFileSync(file, 'utf8').trim() : env[name];
}
function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error('Invalid numeric configuration');
  return parsed;
}
export function databaseConfig(env: NodeJS.ProcessEnv = process.env): PoolConfig {
  const connectionString = secret('DATABASE_URL', env);
  return connectionString ? { connectionString, max: 10 } : {
    host: env.DATABASE_HOST ?? '127.0.0.1', port: integer(env.DATABASE_PORT, 5432, 1, 65535),
    database: env.DATABASE_NAME ?? 'zhijiao', user: env.DATABASE_USER ?? 'zhijiao',
    password: secret('DATABASE_PASSWORD', env), max: 10,
  };
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = integer(env.PORT, 3000, 1, 65535);
  const origin = env.APP_ORIGIN ?? `http://localhost:${port}`;
  const url = new URL(origin);
  if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol)) throw new Error('APP_ORIGIN must be an exact HTTP(S) origin');
  if (env.NODE_ENV === 'production' && url.protocol !== 'https:') throw new Error('Production APP_ORIGIN requires trusted HTTPS');
  const sessionSecret = secret('SESSION_SECRET', env);
  if (!sessionSecret || sessionSecret.length < 32) throw new Error('Configure SESSION_SECRET_FILE with at least 32 characters');
  return { database: databaseConfig(env), origin, secret: sessionSecret, secure: url.protocol === 'https:',
    idleMs: integer(env.SESSION_IDLE_MS, 86400000, 60000, 604800000),
    absoluteMs: integer(env.SESSION_ABSOLUTE_MS, 2592000000, 60000, 7776000000),
    trustProxy: integer(env.TRUST_PROXY, 0, 0, 2), port, staticDir: env.STATIC_DIR };
}
