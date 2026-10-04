import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  migrate,
  checkMigrations,
} from '../../src/infrastructure/db/migrations.js';

const url = process.env.TEST_DATABASE_URL;
test(
  'failed DDL rolls back migration bookkeeping atomically',
  { skip: !url },
  async () => {
    const admin = new Pool({ connectionString: url });
    const schema = `test_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new Pool({
      connectionString: url,
      options: `-c search_path=${schema}`,
    });
    try {
      await pool.query('CREATE TABLE users (existing INTEGER)');
      await assert.rejects(migrate(pool), /already exists/);
      const result = await pool.query(
        "SELECT to_regclass('schema_migrations') AS table_name",
      );
      assert.equal(result.rows[0].table_name, null);
      await pool.query('SELECT existing FROM users');
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);
test(
  'real PostgreSQL: concurrent migrations, checksums, bigint, timestamptz, rollback',
  { skip: !url },
  async () => {
    const admin = new Pool({ connectionString: url });
    const schema = `test_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new Pool({
      connectionString: url,
      options: `-c search_path=${schema} -c timezone=UTC`,
    });
    try {
      await Promise.all([migrate(pool), migrate(pool)]);
      await migrate(pool);
      await checkMigrations(pool);
      assert.equal(
        (await pool.query('SELECT * FROM schema_migrations')).rowCount,
        7,
      );
      const id = randomUUID();
      await pool.query(
        'INSERT INTO users (id, telegram_user_id, default_timezone) VALUES ($1, $2, $3)',
        [id, '9007199254740993', 'Asia/Tehran'],
      );
      const row = (
        await pool.query(
          'SELECT telegram_user_id, created_at FROM users WHERE id=$1',
          [id],
        )
      ).rows[0];
      assert.equal(row.telegram_user_id, '9007199254740993');
      assert.ok(row.created_at instanceof Date);
      await assert.rejects(
        pool.query(
          'INSERT INTO users (id, telegram_user_id, default_timezone) VALUES ($1,$2,$3)',
          [randomUUID(), '9007199254740993', 'UTC'],
        ),
      );
      await pool.query("UPDATE schema_migrations SET checksum='changed'");
      await assert.rejects(checkMigrations(pool), /Migrations required/);
      await assert.rejects(migrate(pool), /history mismatch/);
      assert.equal(
        (await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n,
        1,
      );
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);
