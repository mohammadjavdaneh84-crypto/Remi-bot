import { createPool } from './pool.js';
import { migrate } from './migrations.js';
import { createLogger } from '../logging/logger.js';

const log = createLogger();
if (!process.env.DATABASE_URL) {
  log.error({ event: 'migration.config_missing' });
  process.exitCode = 1;
} else {
  const pool = createPool(process.env.DATABASE_URL);
  try {
    await migrate(pool);
    log.info({ event: 'migration.completed' });
  } catch {
    log.error({ event: 'migration.failed' });
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
