import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withDatabase, databaseUrl } from '../helpers/database.js';
import {
  seedManaged,
  managementNow as now,
  countedDaily,
} from '../helpers/management.js';
import { PgManagementRepository } from '../../src/infrastructure/db/management.js';
import { PgWizardRepository } from '../../src/infrastructure/db/wizard.js';
import { PgScheduleProducer } from '../../src/infrastructure/db/scheduler.js';
import { PgDeliveryRepository } from '../../src/infrastructure/db/deliveries.js';
import { DeliveryWorker } from '../../src/app/delivery/worker.js';
import { classifyDelivery } from '../../src/infrastructure/telegram/delivery.js';
import type { Session } from '../../src/app/wizard/model.js';
const options = { skip: !databaseUrl };

test(
  'pause cancels only pending scheduled work; resume skips pause, preserves anchor/parity and count',
  options,
  async () => {
    await withDatabase(async (pool, owner) => {
      const data = await seedManaged(pool, owner, [
        countedDaily,
        {
          type: 'WEEKLY',
          every: 2,
          weekdays: [5],
          anchorDate: '2026-10-09',
          localTime: '18:00',
          end: { type: 'UNLIMITED' },
        },
      ]);
      await new PgScheduleProducer(pool).tick(now);
      const repo = new PgManagementRepository(pool);
      await repo.act(owner, data.id, 0, 'run', 1, now);
      await repo.act(owner, data.id, 1, 'pause', 2, now);
      const states = (
        await pool.query(
          'SELECT trigger_kind,state FROM executions ORDER BY trigger_kind',
        )
      ).rows;
      assert.deepEqual(states, [
        { trigger_kind: 'MANUAL', state: 'PENDING' },
        { trigger_kind: 'SCHEDULED', state: 'CANCELLED' },
      ]);
      assert.equal(
        (await pool.query('SELECT * FROM reminder_versions')).rowCount,
        1,
      );
      assert.equal(
        (await new PgScheduleProducer(pool).tick('2026-10-20T00:00:00Z'))
          .executions,
        0,
      );
      await repo.act(owner, data.id, 2, 'resume', 3, '2026-10-20T00:00:00Z');
      const cursors = (
        await pool.query(
          'SELECT * FROM schedule_cursors ORDER BY schedule_rule_id',
        )
      ).rows;
      const daily = cursors.find(
          (c) => c.schedule_rule_id === data.ruleIds[0],
        )!,
        weekly = cursors.find((c) => c.schedule_rule_id === data.ruleIds[1])!;
      assert.equal(daily.consumed_count, 1);
      assert.equal(daily.next_due_at.toISOString(), '2026-10-20T12:00:00.000Z');
      assert.equal(
        weekly.next_due_at.toISOString(),
        '2026-10-23T18:00:00.000Z',
      );
      assert.equal(
        (await new PgScheduleProducer(pool).tick('2026-10-20T00:00:00Z'))
          .executions,
        0,
      );
    });
  },
);
test(
  'manual action is replay-safe and concurrent confirmation creates one execution; paused manual can deliver',
  options,
  async () => {
    await withDatabase(async (pool, owner) => {
      const data = await seedManaged(pool, owner);
      const repo = new PgManagementRepository(pool);
      await repo.act(owner, data.id, 0, 'pause', 1, now);
      const results = await Promise.allSettled([
        repo.act(owner, data.id, 1, 'run', 2, now),
        repo.act(owner, data.id, 1, 'run', 3, now),
      ]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      const used = results[0]!.status === 'fulfilled' ? 2 : 3;
      assert.equal(await repo.act(owner, data.id, 1, 'run', used, now), null);
      assert.equal((await pool.query('SELECT * FROM executions')).rowCount, 1);
      assert.equal(
        (await pool.query('SELECT consumed_count FROM schedule_cursors'))
          .rows[0].consumed_count,
        0,
      );
      const calls: number[] = [];
      const worker = new DeliveryWorker(
        new PgDeliveryRepository(pool),
        {
          check: async () => data.target,
          copy: async (_chat, u) => {
            calls.push(...u.messageIds);
            return u.messageIds.map((n) => n + 1000);
          },
          classify: classifyDelivery,
          unavailable: async () => {},
        },
        5,
        () => now,
      );
      await worker.runOne();
      assert.deepEqual(calls, [101, 102]);
      assert.equal(
        (await pool.query('SELECT state FROM executions')).rows[0].state,
        'SUCCEEDED',
      );
      assert.equal((await repo.get(owner, data.id))!.status, 'PAUSED');
    });
  },
);
test(
  'duplicate has new paused identity/version 1, shared content references and zero runtime/history',
  options,
  async () => {
    await withDatabase(async (pool, owner) => {
      const data = await seedManaged(pool, owner);
      await new PgScheduleProducer(pool).tick(now);
      const repo = new PgManagementRepository(pool);
      const clone = (await repo.act(owner, data.id, 0, 'duplicate', 1, now))!;
      const r = (await repo.get(owner, clone))!;
      assert.equal(r.status, 'PAUSED');
      assert.match(r.name, /کپی/);
      assert.equal(r.nextDue, null);
      const v = (
        await pool.query(
          'SELECT * FROM reminder_versions WHERE reminder_id=$1',
          [clone],
        )
      ).rows[0];
      assert.equal(v.version_no, 1);
      assert.equal(v.missed_run_policy, 'CATCH_UP');
      assert.equal(
        (
          await pool.query('SELECT * FROM executions WHERE reminder_id=$1', [
            clone,
          ])
        ).rowCount,
        0,
      );
      const cursors = (
        await pool.query(
          'SELECT c.* FROM schedule_cursors c JOIN schedule_rules s ON s.id=c.schedule_rule_id WHERE s.reminder_version_id=$1',
          [v.id],
        )
      ).rows;
      assert.ok(cursors.every((c) => c.consumed_count === 0 && !c.active));
      assert.deepEqual(
        (
          await pool.query(
            'SELECT archive_id FROM content_items WHERE reminder_version_id=$1 ORDER BY position',
            [v.id],
          )
        ).rows.map((r) => r.archive_id),
        data.archives,
      );
      assert.equal(
        (await pool.query('SELECT * FROM content_archives')).rowCount,
        2,
      );
    });
  },
);
test(
  'edit activation is atomic, keeps live counts for unchanged rules and cancels only old pending executions',
  options,
  async () => {
    await withDatabase(async (pool, owner) => {
      const data = await seedManaged(pool, owner);
      const wizard = new PgWizardRepository(pool);
      let s!: Session;
      await wizard.run(owner, 1, async (tx) => {
        s = await tx.edit!(data.id, now);
        return null;
      });
      // A scheduled occurrence while editing must not be lost/reset by a stale draft count.
      await new PgScheduleProducer(pool).tick(now);
      await wizard.run(owner, 2, async (tx) => {
        s = (await tx.current(now))!;
        s.draft.name = 'نام جدید';
        s.draft.archives.reverse();
        await tx.commit(s, now);
        return null;
      });
      const versions = (
        await pool.query('SELECT * FROM reminder_versions ORDER BY version_no')
      ).rows;
      assert.equal(versions.length, 2);
      assert.equal(versions[0].name, 'مدیریت');
      assert.ok(versions[0].retired_at);
      assert.equal(versions[0].superseded_by_version_id, versions[1].id);
      assert.equal(versions[1].name, 'نام جدید');
      const newCursor = (
        await pool.query(
          'SELECT c.* FROM schedule_cursors c JOIN schedule_rules s ON s.id=c.schedule_rule_id WHERE s.reminder_version_id=$1',
          [versions[1].id],
        )
      ).rows[0];
      assert.equal(newCursor.consumed_count, 1);
      assert.equal(
        newCursor.next_due_at.toISOString(),
        '2026-10-04T12:00:00.000Z',
      );
      assert.deepEqual(
        (
          await pool.query(
            'SELECT archive_id FROM content_items WHERE reminder_version_id=$1 ORDER BY position',
            [versions[1].id],
          )
        ).rows.map((r) => r.archive_id),
        [...data.archives].reverse(),
      );
      assert.equal(
        (await pool.query('SELECT state FROM executions')).rows[0].state,
        'CANCELLED',
      );
      assert.equal(
        (
          await pool.query(
            'SELECT active FROM schedule_cursors WHERE schedule_rule_id=$1',
            [data.ruleIds[0]],
          )
        ).rows[0].active,
        false,
      );
    });
  },
);
test(
  'failed version assembly rolls back retirement, cancellation and active pointer; same save can retry',
  options,
  async () => {
    await withDatabase(async (pool, owner) => {
      const data = await seedManaged(pool, owner);
      await new PgScheduleProducer(pool).tick(now);
      const wizard = new PgWizardRepository(pool);
      await wizard.run(owner, 1, async (tx) => {
        await tx.edit!(data.id, now);
        return null;
      });
      await pool.query(`CREATE FUNCTION fail_activation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.version_no=2 AND NEW.activated_at IS NOT NULL THEN RAISE EXCEPTION 'injected activation failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_activation BEFORE UPDATE ON reminder_versions FOR EACH ROW EXECUTE FUNCTION fail_activation()`);
      await assert.rejects(
        wizard.run(owner, 2, async (tx) => {
          const s = (await tx.current(now))!;
          await tx.commit(s, now);
          return null;
        }),
        /injected/,
      );
      assert.equal(
        (await pool.query('SELECT current_version_id FROM reminders')).rows[0]
          .current_version_id,
        data.version,
      );
      assert.equal(
        (await pool.query('SELECT * FROM reminder_versions')).rowCount,
        1,
      );
      assert.equal(
        (await pool.query('SELECT state FROM executions')).rows[0].state,
        'PENDING',
      );
      await pool.query('DROP TRIGGER fail_activation ON reminder_versions');
      await wizard.run(owner, 2, async (tx) => {
        await tx.commit((await tx.current(now))!, now);
        return null;
      });
      assert.equal(
        (await pool.query('SELECT * FROM reminder_versions')).rowCount,
        2,
      );
    });
  },
);
test(
  'soft delete and edit cancellation preserve content/history; deleted draft cannot resurrect reminder',
  options,
  async () => {
    await withDatabase(async (pool, owner, other) => {
      const data = await seedManaged(pool, owner);
      const repo = new PgManagementRepository(pool),
        wizard = new PgWizardRepository(pool);
      assert.equal(await repo.get(other, data.id), null);
      assert.equal((await repo.content(other, data.id)).length, 0);
      await assert.rejects(repo.act(other, data.id, 0, 'delete', 1, now));
      await wizard.run(owner, 1, async (tx) => {
        await tx.edit!(data.id, now);
        return null;
      });
      await wizard.run(owner, 2, async (tx) => {
        const s = (await tx.current(now))!;
        s.status = 'CANCELLED';
        await tx.save(s);
        return null;
      });
      assert.equal(
        (await pool.query('SELECT * FROM reminder_versions')).rowCount,
        1,
      );
      await wizard.run(owner, 3, async (tx) => {
        await tx.edit!(data.id, now);
        return null;
      });
      await new PgScheduleProducer(pool).tick(now);
      await repo.act(owner, data.id, 0, 'delete', 4, now);
      await assert.rejects(
        wizard.run(owner, 5, async (tx) => {
          await tx.commit((await tx.current(now))!, now);
          return null;
        }),
        /base changed/,
      );
      assert.equal(await repo.get(owner, data.id), null);
      assert.equal((await repo.list(owner, 0)).rows.length, 0);
      assert.equal(
        (await pool.query('SELECT * FROM content_archives')).rowCount,
        2,
      );
      assert.equal(
        (await pool.query('SELECT state FROM executions')).rows[0].state,
        'CANCELLED',
      );
    });
  },
);
test(
  'editing a paused copy keeps it paused, rules toggle/duplicate/update get fresh IDs and appropriate counts',
  options,
  async () => {
    await withDatabase(async (pool, owner) => {
      const data = await seedManaged(pool, owner);
      await new PgScheduleProducer(pool).tick(now);
      const repo = new PgManagementRepository(pool);
      await repo.act(owner, data.id, 0, 'pause', 1, now);
      const wizard = new PgWizardRepository(pool);
      await wizard.run(owner, 2, async (tx) => {
        const s = await tx.edit!(data.id, now);
        s.draft.rules[0]!.enabled = false;
        s.draft.rules.push({
          id: randomUUID(),
          config: { ...countedDaily, every: 2 },
        });
        s.draft.timezone = 'Asia/Tehran';
        s.draft.missedPolicy = 'SKIP';
        await tx.save(s);
        return null;
      });
      await wizard.run(owner, 3, async (tx) => {
        await tx.commit((await tx.current(now))!, now);
        return null;
      });
      assert.equal((await repo.get(owner, data.id))!.status, 'PAUSED');
      const rules = (
        await pool.query(
          'SELECT s.*,c.consumed_count,c.active FROM schedule_rules s JOIN schedule_cursors c ON c.schedule_rule_id=s.id JOIN reminders r ON r.current_version_id=s.reminder_version_id ORDER BY s.position',
        )
      ).rows;
      assert.equal(rules[0].enabled, false);
      assert.equal(rules[0].consumed_count, 1);
      assert.equal(rules[1].consumed_count, 0);
      assert.ok(rules.every((r) => !r.active));
      assert.notEqual(rules[0].id, data.ruleIds[0]);
      assert.equal(
        (
          await pool.query(
            'SELECT missed_run_policy FROM reminder_versions ORDER BY version_no DESC LIMIT 1',
          )
        ).rows[0].missed_run_policy,
        'SKIP',
      );
    });
  },
);
test(
  'processing old execution survives version save and delete while pending work is cancelled',
  options,
  async () => {
    await withDatabase(async (pool, owner) => {
      const data = await seedManaged(pool, owner);
      await new PgScheduleProducer(pool).tick(now);
      await assert.rejects(
        new PgDeliveryRepository(pool).runNext(now, async (s) => {
          await s.sending(s.units[0]!, '-2001');
          await s.sent(s.units[0]!, [1101]);
          throw new Error('between units');
        }),
      );
      const wizard = new PgWizardRepository(pool);
      await wizard.run(owner, 1, async (tx) => {
        const s = await tx.edit!(data.id, now);
        s.draft.name = 'تعریف تازه';
        await tx.commit(s, now);
        return null;
      });
      const repo = new PgManagementRepository(pool),
        r = (await repo.get(owner, data.id))!;
      await repo.act(owner, data.id, r.revision, 'delete', 2, now);
      const calls: number[] = [];
      await new DeliveryWorker(
        new PgDeliveryRepository(pool),
        {
          check: async () => data.target,
          copy: async (_chat, u) => {
            calls.push(...u.messageIds);
            return [1102];
          },
          classify: classifyDelivery,
          unavailable: async () => {},
        },
        5,
        () => now,
      ).runOne();
      assert.deepEqual(calls, [102]);
      assert.equal(
        (await pool.query('SELECT state,reminder_version_id FROM executions'))
          .rows[0].state,
        'SUCCEEDED',
      );
      assert.equal(
        (await pool.query('SELECT reminder_version_id FROM executions')).rows[0]
          .reminder_version_id,
        data.version,
      );
    });
  },
);
test(
  'concurrent edit saves and scheduler commit one version and never duplicate the same scheduled instant',
  options,
  async () => {
    await withDatabase(async (pool, owner) => {
      const data = await seedManaged(pool, owner);
      const wizard = new PgWizardRepository(pool);
      await wizard.run(owner, 1, async (tx) => {
        await tx.edit!(data.id, now);
        return null;
      });
      const results = await Promise.allSettled([
        wizard.run(owner, 2, async (tx) => {
          const s = await tx.current(now);
          if (s) await tx.commit(s, now);
          return null;
        }),
        wizard.run(owner, 3, async (tx) => {
          const s = await tx.current(now);
          if (s) await tx.commit(s, now);
          return null;
        }),
        new PgScheduleProducer(pool).tick(now),
      ]);
      assert.ok(results.every((r) => r.status === 'fulfilled'));
      assert.equal(
        (await pool.query('SELECT * FROM reminder_versions')).rowCount,
        2,
      );
      assert.equal(
        (await pool.query('SELECT * FROM executions')).rowCount! <= 1,
        true,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT * FROM reminder_versions WHERE retired_at IS NULL',
          )
        ).rowCount,
        1,
      );
    });
  },
);
