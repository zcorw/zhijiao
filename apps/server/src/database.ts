import { Pool, type PoolClient } from 'pg';
import type { AppConfig } from './config.js';
export const DATABASE = Symbol('DATABASE');
export const CONFIG = Symbol('CONFIG');
export function makePool(config: AppConfig): Pool { return new Pool(config.database); }
export async function transaction<T>(pool: Pool, work: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try { await db.query('BEGIN'); const result = await work(db); await db.query('COMMIT'); return result; }
  catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}
