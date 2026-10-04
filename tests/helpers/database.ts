import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrate } from '../../src/infrastructure/db/migrations.js';

export const databaseUrl = process.env.TEST_DATABASE_URL;
export async function withDatabase(
  run: (pool: Pool, ownerId: string, otherOwnerId: string) => Promise<void>,
) {
  const admin = new Pool({ connectionString: databaseUrl });
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema} -c timezone=UTC`,
  });
  try {
    await migrate(pool);
    const ownerId = randomUUID();
    const otherOwnerId = randomUUID();
    await pool.query(
      "INSERT INTO users (id,telegram_user_id,default_timezone) VALUES ($1,123,'UTC'), ($2,999,'UTC')",
      [ownerId, otherOwnerId],
    );
    await run(pool, ownerId, otherOwnerId);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
}
