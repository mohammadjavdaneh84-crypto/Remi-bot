import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { PgScheduleProducer } from '../../src/infrastructure/db/scheduler.js';
import { PgTargetRepository } from '../../src/infrastructure/db/targets.js';
import type { Rule } from '../../src/domain/schedule/rule.js';
import type { MissedPolicy } from '../../src/domain/schedule/production.js';
import { nextOccurrence } from '../../src/domain/schedule/recurrence.js';
import { databaseUrl, withDatabase } from '../helpers/database.js';
import { snapshot } from '../helpers/phase2.js';
const options = { skip: !databaseUrl };
const now = '2026-10-03T12:00:10Z';
const daily: Rule = {
  type: 'EVERY_N_DAYS',
  every: 1,
  anchorDate: '2026-10-01',
  localTime: '12:00',
  end: { type: 'UNLIMITED' },
};
async function seed(
  pool: Pool,
  owner: string,
  rules: Rule[] = [daily],
  policy: MissedPolicy = 'LATEST_ONLY',
) {
  const reminder = randomUUID(),
    version = randomUUID(),
    ruleIds: string[] = [];
  await pool.query(
    "INSERT INTO reminders(id,owner_user_id,status) VALUES($1,$2,'PAUSED')",
    [reminder, owner],
  );
  await pool.query(
    "INSERT INTO reminder_versions(id,reminder_id,version_no,name,timezone,missed_run_policy) VALUES($1,$2,1,'scheduler test','UTC',$3)",
    [version, reminder, policy],
  );
  for (const [position, rule] of rules.entries()) {
    const id = randomUUID();
    ruleIds.push(id);
    await pool.query(
      'INSERT INTO schedule_rules(id,reminder_version_id,position,config) VALUES($1,$2,$3,$4)',
      [id, version, position, rule],
    );
    await pool.query(
      'INSERT INTO schedule_cursors(schedule_rule_id,next_due_at) VALUES($1,$2)',
      [
        id,
        nextOccurrence(rule, '2026-09-30T23:59:59Z', {
          timezone: 'UTC',
          calendarSystem: 'gregorian',
        }),
      ],
    );
  }
  for (let i = 0; i < 2; i++) {
    const target = await new PgTargetRepository(pool).save(owner, {
      ...snapshot,
      chatId: String(-2000 - i),
    });
    await pool.query(
      'INSERT INTO reminder_version_targets(reminder_version_id,target_id,position) VALUES($1,$2,$3)',
      [version, target.id, i],
    );
  }
  await pool.query(
    "UPDATE reminder_versions SET activated_at='2026-10-01T00:00:00Z' WHERE id=$1",
    [version],
  );
  await pool.query(
    "UPDATE reminders SET current_version_id=$2,status='ACTIVE' WHERE id=$1",
    [reminder, version],
  );
  return { reminder, version, ruleIds };
}
test(
  'two producers merge simultaneous rules, create one execution/two deliveries, restart is idempotent',
  options,
  async () => {
    await withDatabase(async (pool, owner) => {
      const data = await seed(pool, owner, [
        daily,
        { ...daily, end: { type: 'AFTER_N_EXECUTIONS', count: 1 } },
      ]);
      const results = await Promise.all(
        Array.from({ length: 8 }, () => new PgScheduleProducer(pool).tick(now)),
      );
      assert.equal(
        results.reduce((n, r) => n + r.executions, 0),
        1,
      );
      const executions = (await pool.query('SELECT * FROM executions')).rows;
      assert.equal(executions.length, 1);
      assert.equal(executions[0].state, 'PENDING');
      assert.equal(
        executions[0].scheduled_for.toISOString(),
        '2026-10-03T12:00:00.000Z',
      );
      assert.equal(
        (await pool.query('SELECT * FROM execution_rules')).rowCount,
        2,
      );
      assert.equal((await pool.query('SELECT * FROM deliveries')).rowCount, 2);
      const cursors = (await pool.query('SELECT * FROM schedule_cursors')).rows;
      assert.ok(cursors.every((c) => c.consumed_count === 1));
      assert.equal(cursors.filter((c) => c.active).length, 1);
      assert.equal(
        (await new PgScheduleProducer(pool).tick(now)).executions,
        0,
      );
      await assert.rejects(
        pool.query(
          `INSERT INTO executions(id,reminder_id,reminder_version_id,scheduled_for,trigger_kind,dedupe_key)
      VALUES($1,$2,$3,'2026-10-03T12:00:00Z','SCHEDULED','different-key')`,
          [randomUUID(), data.reminder, data.version],
        ),
        /unique/,
      );
    });
  },
);
test(
  'SKIP LOCKED avoids a held reminder and can produce an independent reminder',
  options,
  async () => {
    await withDatabase(async (pool, owner) => {
      const first = await seed(pool, owner),
        second = await seed(pool, owner);
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM reminders WHERE id=$1 FOR UPDATE', [
          first.reminder,
        ]);
        await pool.query("SET statement_timeout='2s'");
        const result = await new PgScheduleProducer(pool).tick(now);
        assert.equal(result.executions, 1);
        assert.equal(
          (await pool.query('SELECT reminder_id FROM executions')).rows[0]
            .reminder_id,
          second.reminder,
        );
        await holder.query('ROLLBACK');
        assert.equal(
          (await new PgScheduleProducer(pool).tick(now)).executions,
          1,
        );
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
      }
    });
  },
);
test(
  'cursor write failure rolls back executions, links, deliveries and every count; retry succeeds',
  options,
  async () => {
    await withDatabase(async (pool, owner) => {
      await seed(pool, owner, [daily, daily]);
      await pool.query(`CREATE FUNCTION fail_cursor() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected cursor failure'; END $$;
      CREATE TRIGGER fail_cursor BEFORE UPDATE ON schedule_cursors FOR EACH ROW EXECUTE FUNCTION fail_cursor()`);
      await assert.rejects(
        new PgScheduleProducer(pool).tick(now),
        /injected cursor failure/,
      );
      for (const table of ['executions', 'execution_rules', 'deliveries'])
        assert.equal((await pool.query(`SELECT * FROM ${table}`)).rowCount, 0);
      assert.ok(
        (
          await pool.query('SELECT consumed_count FROM schedule_cursors')
        ).rows.every((r) => r.consumed_count === 0),
      );
      await pool.query('DROP TRIGGER fail_cursor ON schedule_cursors');
      assert.equal(
        (await new PgScheduleProducer(pool).tick(now)).executions,
        1,
      );
    });
  },
);
test(
  'catch-up cap persists across producers and restart; exhausted count does not hold unnecessarily',
  options,
  async () => {
    await withDatabase(async (pool, owner) => {
      await seed(
        pool,
        owner,
        [daily, { ...daily, end: { type: 'AFTER_N_EXECUTIONS', count: 2 } }],
        'CATCH_UP',
      );
      const result = await new PgScheduleProducer(pool, 2).tick(now);
      assert.equal(result.executions, 2);
      assert.equal(result.blockedRules, 1);
      const cursors = (await pool.query('SELECT * FROM schedule_cursors')).rows;
      assert.ok(cursors.every((c) => !c.active && c.consumed_count === 2));
      const held = cursors.find((c) => c.blocked_reason)!;
      assert.equal(held.blocked_reason, 'CATCH_UP_LIMIT');
      assert.equal(held.next_due_at.toISOString(), '2026-10-03T12:00:00.000Z');
      assert.equal(
        (await new PgScheduleProducer(pool, 2).tick('2026-10-10T12:00:00Z'))
          .executions,
        0,
      );
      assert.equal(
        (await pool.query('SELECT * FROM execution_rules')).rowCount,
        4,
      );
    });
  },
);
test(
  'SKIP advances without consuming counts, but current minute executes',
  options,
  async () => {
    await withDatabase(async (pool, owner) => {
      await seed(pool, owner, [daily], 'SKIP');
      assert.equal(
        (await new PgScheduleProducer(pool).tick('2026-10-03T11:59:59Z'))
          .executions,
        0,
      );
      assert.equal(
        (await pool.query('SELECT consumed_count FROM schedule_cursors'))
          .rows[0].consumed_count,
        0,
      );
      assert.equal(
        (await new PgScheduleProducer(pool).tick(now)).executions,
        1,
      );
    });
  },
);
test(
  'paused, deleted, retired and disabled cursors cannot produce',
  options,
  async () => {
    await withDatabase(async (pool, owner) => {
      const paused = await seed(pool, owner),
        deleted = await seed(pool, owner),
        retired = await seed(pool, owner),
        disabled = await seed(pool, owner);
      await pool.query("UPDATE reminders SET status='PAUSED' WHERE id=$1", [
        paused.reminder,
      ]);
      await pool.query("UPDATE reminders SET status='DELETED' WHERE id=$1", [
        deleted.reminder,
      ]);
      await pool.query(
        'UPDATE reminder_versions SET retired_at=$2 WHERE id=$1',
        [retired.version, now],
      );
      await pool.query(
        'UPDATE schedule_cursors SET active=false WHERE schedule_rule_id=$1',
        [disabled.ruleIds[0]],
      );
      assert.equal(
        (await new PgScheduleProducer(pool).tick(now)).executions,
        0,
      );
      assert.ok(
        (
          await pool.query('SELECT consumed_count FROM schedule_cursors')
        ).rows.every((r) => r.consumed_count === 0),
      );
    });
  },
);
test(
  'old version and future activation excluded; exact instants do not collapse nearby occurrences',
  options,
  async () => {
    await withDatabase(async (pool, owner) => {
      const old = await seed(pool, owner, [
        { type: 'ONE_TIME', at: '2026-10-03T12:00:00Z' },
      ]);
      const version = randomUUID();
      await pool.query(
        'UPDATE reminder_versions SET retired_at=$2 WHERE id=$1',
        [old.version, now],
      );
      await pool.query(
        "INSERT INTO reminder_versions(id,reminder_id,version_no,name,timezone) VALUES($1,$2,2,'new','UTC')",
        [version, old.reminder],
      );
      await pool.query(
        'UPDATE reminders SET current_version_id=$2 WHERE id=$1',
        [old.reminder, version],
      );
      const futureRule = randomUUID();
      await pool.query(
        'INSERT INTO schedule_rules(id,reminder_version_id,position,config) VALUES($1,$2,0,$3)',
        [futureRule, version, daily],
      );
      await pool.query(
        "INSERT INTO schedule_cursors(schedule_rule_id,next_due_at) VALUES($1,'2026-10-03T12:00:00Z')",
        [futureRule],
      );
      assert.equal(
        (await new PgScheduleProducer(pool).tick(now)).executions,
        0,
      );
      await pool.query(
        "UPDATE reminder_versions SET activated_at='2026-11-01T00:00:00Z' WHERE id=$1",
        [version],
      );
      assert.equal(
        (await new PgScheduleProducer(pool).tick(now)).executions,
        0,
      );
      await seed(pool, owner, [
        { type: 'ONE_TIME', at: '2026-10-03T12:00:00.000001Z' },
        { type: 'ONE_TIME', at: '2026-10-03T12:00:00.000002Z' },
      ]);
      assert.equal(
        (await new PgScheduleProducer(pool).tick(now)).executions,
        2,
      );
      assert.equal(
        (await pool.query('SELECT DISTINCT scheduled_for FROM executions'))
          .rowCount,
        2,
      );
    });
  },
);
test(
  'DB rejects cross-version rule links and duplicate target delivery',
  options,
  async () => {
    await withDatabase(async (pool, owner) => {
      const a = await seed(pool, owner),
        b = await seed(pool, owner);
      await new PgScheduleProducer(pool).tick(now);
      const execution = (
        await pool.query(
          'SELECT id FROM executions WHERE reminder_version_id=$1',
          [a.version],
        )
      ).rows[0].id;
      await assert.rejects(
        pool.query('INSERT INTO execution_rules VALUES($1,$2,$3)', [
          execution,
          b.ruleIds[0],
          a.version,
        ]),
        /foreign key/,
      );
      const delivery = (
        await pool.query(
          'SELECT * FROM deliveries WHERE execution_id=$1 LIMIT 1',
          [execution],
        )
      ).rows[0];
      await assert.rejects(
        pool.query(
          'INSERT INTO deliveries(id,execution_id,target_id,position) VALUES($1,$2,$3,99)',
          [randomUUID(), execution, delivery.target_id],
        ),
        /unique/,
      );
    });
  },
);
test(
  'delivery snapshot uses immutable version targets even if permission becomes unavailable',
  options,
  async () => {
    await withDatabase(async (pool, owner) => {
      await seed(pool, owner);
      await pool.query('UPDATE targets SET is_reachable=false');
      await new PgScheduleProducer(pool).tick(now);
      assert.equal(
        (
          await pool.query(
            "SELECT * FROM deliveries WHERE state='PENDING' AND attempt_count=0",
          )
        ).rowCount,
        2,
      );
      // Phase 5 revalidates permissions; a temporary outage must not silently drop a target.
    });
  },
);

test(
  'manual executions and delivery failures do not alter scheduled rule counting',
  options,
  async () => {
    await withDatabase(async (pool, owner) => {
      const data = await seed(pool, owner);
      await pool.query(
        `INSERT INTO executions(id,reminder_id,reminder_version_id,scheduled_for,trigger_kind,dedupe_key)
      VALUES($1,$2,$3,$4,'MANUAL',$5)`,
        [randomUUID(), data.reminder, data.version, now, randomUUID()],
      );
      await new PgScheduleProducer(pool).tick(now);
      await pool.query("UPDATE deliveries SET state='FAILED_PERMANENT'");
      await pool.query(
        "UPDATE executions SET state='FAILED' WHERE trigger_kind='SCHEDULED'",
      );
      assert.equal(
        (await new PgScheduleProducer(pool).tick(now)).executions,
        0,
      );
      await new PgScheduleProducer(pool).tick('2026-10-04T12:00:10Z');
      assert.equal(
        (await pool.query('SELECT consumed_count FROM schedule_cursors'))
          .rows[0].consumed_count,
        2,
      );
      assert.equal((await pool.query('SELECT * FROM executions')).rowCount, 3);
    });
  },
);
