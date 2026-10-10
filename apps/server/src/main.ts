import { loadConfig } from './config.js';
import { makePool } from './database.js';
import { createApplication } from './app.js';
let pool: ReturnType<typeof makePool> | undefined;
let server: Awaited<ReturnType<typeof createApplication>> | undefined;
try {
  const config = loadConfig(); pool = makePool(config);
  const schema = await pool.query('SELECT version FROM zj_schema WHERE version=1');
  if (!schema.rowCount) throw new Error('Run the controlled migration command before starting.');
  server = await createApplication(config, pool);
  await server.app.listen(config.port, '0.0.0.0');
  console.log(`Zhijiao is listening on port ${config.port}.`);
  let closing = false;
  const shutdown = async () => { if (closing) return; closing = true; await server?.close(); await pool?.end(); };
  process.once('SIGTERM', () => { void shutdown(); }); process.once('SIGINT', () => { void shutdown(); });
} catch {
  await server?.close(); await pool?.end();
  console.error('Application startup failed. Check configuration, database and migrations.'); process.exitCode = 1;
}
