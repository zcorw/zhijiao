import 'reflect-metadata';
import { Pool } from 'pg';
import { fileURLToPath } from 'node:url';
import { migrateAccounts } from '@tts-workbench/account-postgres';
import { databaseConfig } from './config.js';
import { applicationSchema } from './schema.js';
export async function migrate(pool: Pool): Promise<void> {
  const db = await pool.connect();
  try {
    await db.query("SELECT pg_advisory_lock(hashtextextended('zhijiao:schema',0))");
    await migrateAccounts(db);
    await db.query('BEGIN');
    await db.query(applicationSchema);
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { await db.query("SELECT pg_advisory_unlock(hashtextextended('zhijiao:schema',0))"); db.release(); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pool = new Pool(databaseConfig());
  try { await migrate(pool); console.log('Database migration completed.'); }
  catch { console.error('Migration failed. Review database availability and schema compatibility.'); process.exitCode = 1; }
  finally { await pool.end(); }
}
