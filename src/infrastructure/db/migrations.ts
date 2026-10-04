import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { Pool } from 'pg';

const directory = new URL('../../../migrations/', import.meta.url);
async function files() {
  return Promise.all(
    (await readdir(directory))
      .filter((f) => /^\d+_.+\.sql$/.test(f))
      .sort()
      .map(async (name) => {
        const sql = await readFile(new URL(name, directory), 'utf8');
        return {
          name,
          sql,
          checksum: createHash('sha256').update(sql).digest('hex'),
        };
      }),
  );
}
export async function migrate(pool: Pool): Promise<void> {
  const migrations = await files();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(72636401)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())',
    );
    const applied = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations',
    );
    for (const row of applied.rows) {
      if (
        !migrations.some(
          (m) => m.name === row.name && m.checksum === row.checksum,
        )
      )
        throw new Error('Migration history mismatch');
    }
    for (const migration of migrations) {
      if (applied.rows.some((r) => r.name === migration.name)) continue;
      await client.query(migration.sql);
      await client.query(
        'INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)',
        [migration.name, migration.checksum],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
export async function checkMigrations(pool: Pool): Promise<void> {
  const expected = await files();
  const actual = await pool.query<{ name: string; checksum: string }>(
    'SELECT name, checksum FROM schema_migrations',
  );
  if (
    actual.rows.length !== expected.length ||
    expected.some(
      (e) =>
        !actual.rows.some(
          (a) => a.name === e.name && a.checksum === e.checksum,
        ),
    )
  ) {
    throw new Error('Migrations required');
  }
}
