import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Api, GrammyError } from 'grammy';
import type { Pool } from 'pg';
import { PgDeliveryRepository } from '../../src/infrastructure/db/deliveries.js';
import { PgScheduleProducer } from '../../src/infrastructure/db/scheduler.js';
import { PgTargetRepository } from '../../src/infrastructure/db/targets.js';
import { PgHistoryRepository } from '../../src/infrastructure/db/history.js';
import { DeliveryWorker } from '../../src/app/delivery/worker.js';
import { TelegramDeliveryTransport } from '../../src/infrastructure/telegram/delivery.js';
import { databaseUrl, withDatabase } from '../helpers/database.js';
import { snapshot, chat, admin } from '../helpers/phase2.js';
const options = { skip: !databaseUrl };
const now = '2026-10-03T12:00:10Z';
async function seed(pool: Pool, owner: string, targetCount = 1) {
  const reminder = randomUUID(),
    version = randomUUID(),
    rule = randomUUID();
  await pool.query(
    "INSERT INTO reminders(id,owner_user_id,status) VALUES($1,$2,'PAUSED')",
    [reminder, owner],
  );
  await pool.query(
    "INSERT INTO reminder_versions(id,reminder_id,version_no,name,timezone) VALUES($1,$2,1,'بستهٔ اصلی','UTC')",
    [version, reminder],
  );
  let position = 0;
  for (const [index, kinds] of [
    ['text'],
    ['photo', 'video'],
    ['text'],
  ].entries()) {
    const archive = randomUUID();
    await pool.query(
      "INSERT INTO content_archives(id,owner_user_id,source_key,source_chat_id,storage_chat_id,state) VALUES($1,$2,$3,123,-1001,'READY')",
      [archive, owner, archive],
    );
    for (const [archivePosition, kind] of kinds.entries()) {
      const id = randomUUID();
      await pool.query(
        `INSERT INTO archived_content_items(archive_id,position,source_message_id,storage_message_id,content_type,media_group_key,metadata)
        VALUES($1,$2,$3,$4,$5,$6,'{}')`,
        [
          archive,
          archivePosition,
          position + 1,
          101 + position,
          kind,
          index === 1 ? 'album' : null,
        ],
      );
      await pool.query(
        'INSERT INTO content_items(id,reminder_version_id,position,archive_id,archive_position) VALUES($1,$2,$3,$4,$5)',
        [id, version, position++, archive, archivePosition],
      );
    }
  }
  const targets: string[] = [];
  for (let i = 0; i < targetCount; i++) {
    const target = await new PgTargetRepository(pool).save(owner, {
      ...snapshot,
      chatId: String(-2001 - i),
      title: `Destination ${i}`,
    });
    targets.push(target.id);
    await pool.query(
      'INSERT INTO reminder_version_targets(reminder_version_id,target_id,position) VALUES($1,$2,$3)',
      [version, target.id, i],
    );
  }
  await pool.query(
    'INSERT INTO schedule_rules(id,reminder_version_id,position,config) VALUES($1,$2,0,$3)',
    [
      rule,
      version,
      {
        type: 'EVERY_N_DAYS',
        every: 1,
        anchorDate: '2026-10-03',
        localTime: '12:00',
        end: { type: 'UNLIMITED' },
      },
    ],
  );
  await pool.query(
    "INSERT INTO schedule_cursors(schedule_rule_id,next_due_at) VALUES($1,'2026-10-03T12:00:00Z')",
    [rule],
  );
  await pool.query(
    "UPDATE reminder_versions SET activated_at='2026-10-03T00:00:00Z' WHERE id=$1",
    [version],
  );
  await pool.query(
    "UPDATE reminders SET status='ACTIVE',current_version_id=$2 WHERE id=$1",
    [reminder, version],
  );
  await new PgScheduleProducer(pool).tick(now);
  return { reminder, version, targets };
}
type Copy = { method: string; chat: string; ids: number[] };
function wire(
  pool: Pool,
  hook?: (copy: Copy, index: number) => Promise<unknown>,
) {
  const calls: Copy[] = [];
  const api = new Api('123:test-token');
  api.config.use(async (_prev, method, payload) => {
    const p = payload as {
      chat_id: string;
      message_id?: number;
      message_ids?: number[];
    };
    let result: unknown;
    if (method === 'getChat')
      result = { ...chat, id: Number(p.chat_id), title: 'Destination' };
    else if (method === 'getChatMember') result = admin;
    else {
      const copy = {
        method,
        chat: String(p.chat_id),
        ids: p.message_ids ?? [p.message_id!],
      };
      calls.push(copy);
      result = hook ? await hook(copy, calls.length) : undefined;
      if (result === undefined)
        result =
          method === 'copyMessages'
            ? copy.ids.map((id) => ({ message_id: id + 1000 }))
            : { message_id: copy.ids[0]! + 1000 };
    }
    return { ok: true, result } as never;
  });
  let time = now;
  return {
    calls,
    api,
    time: (t: string) => {
      time = t;
    },
    make: (attempts = 5) =>
      new DeliveryWorker(
        new PgDeliveryRepository(pool),
        new TelegramDeliveryTransport(pool, api, () => 456),
        attempts,
        () => time,
        () => 0,
      ),
  };
}
function error(code: number, retry_after?: number) {
  return new GrammyError(
    'test',
    {
      ok: false,
      error_code: code,
      description: code === 403 ? 'Forbidden' : 'test',
      parameters: retry_after ? { retry_after } : {},
    },
    'copyMessages',
    {},
  );
}

test(
  'preflight transient failure retries without send intent; missing permission stops before copy',
  options,
  async () => {
    for (const permanent of [false, true])
      await withDatabase(async (pool, owner) => {
        await seed(pool, owner);
        const h = wire(pool);
        let reject = true;
        h.api.config.use(async (prev, method, payload, signal) => {
          if (method === 'getChatMember' && reject) {
            if (permanent)
              return {
                ok: true,
                result: { ...admin, can_post_messages: false },
              } as never;
            throw new Error('preflight network outage');
          }
          return prev(method, payload, signal);
        });
        await h.make().runOne();
        assert.equal(h.calls.length, 0);
        assert.equal(
          (await pool.query('SELECT state FROM deliveries')).rows[0].state,
          permanent ? 'FAILED_PERMANENT' : 'FAILED_RETRYABLE',
        );
        assert.ok(
          (
            await pool.query('SELECT attempt_count FROM delivery_items')
          ).rows.every((r) => r.attempt_count === 0),
        );
        if (!permanent) {
          reject = false;
          h.time('2026-10-03T12:01:00Z');
          await h.make().runOne();
          assert.equal(h.calls.length, 3);
        }
      });
  },
);

test(
  'resolved migrated targets are delivered once per execution even when two references converge',
  options,
  async () => {
    await withDatabase(async (pool, owner) => {
      const data = await seed(pool, owner, 2);
      await pool.query('UPDATE targets SET migrated_to_id=$2 WHERE id=$1', [
        data.targets[0],
        data.targets[1],
      ]);
      const h = wire(pool);
      await Promise.all([h.make().runOne(), h.make().runOne()]);
      assert.equal(h.calls.length, 3);
      assert.ok(h.calls.every((c) => c.chat === '-2002'));
      assert.equal(
        (
          await pool.query(
            "SELECT * FROM deliveries WHERE last_error_code='MERGED_TARGET'",
          )
        ).rowCount,
        1,
      );
      assert.equal(
        (await pool.query('SELECT state FROM executions')).rows[0].state,
        'SUCCEEDED',
      );
    });
  },
);

test(
  'newer execution waits behind the same target retry queue',
  options,
  async () => {
    await withDatabase(async (pool, owner) => {
      await seed(pool, owner);
      let reject = true;
      const h = wire(pool, async () => {
        if (reject) throw error(429, 60);
      });
      await h.make().runOne();
      await new PgScheduleProducer(pool).tick('2026-10-04T12:00:10Z');
      assert.equal(await h.make().runOne(), false);
      reject = false;
      h.time('2026-10-04T12:00:10Z');
      await h.make().runOne();
      assert.equal(
        (await pool.query("SELECT * FROM deliveries WHERE state='PENDING'"))
          .rowCount,
        1,
      );
      await h.make().runOne();
      assert.equal(
        (await pool.query("SELECT * FROM deliveries WHERE state='SUCCEEDED'"))
          .rowCount,
        2,
      );
    });
  },
);

test(
  'real DB delivery pipeline: serial text/album/text, parallel targets, exact progress and aggregates',
  options,
  async () => {
    await withDatabase(async (pool, owner) => {
      await seed(pool, owner, 2);
      const h = wire(pool);
      await Promise.all([
        h.make().runOne(),
        h.make().runOne(),
        h.make().runOne(),
      ]);
      assert.equal(h.calls.length, 6);
      for (const target of ['-2001', '-2002'])
        assert.deepEqual(
          h.calls
            .filter((c) => c.chat === target)
            .map((c) => [c.method, c.ids]),
          [
            ['copyMessage', [101]],
            ['copyMessages', [102, 103]],
            ['copyMessage', [104]],
          ],
        );
      assert.equal(
        (await pool.query("SELECT * FROM delivery_items WHERE state='SENT'"))
          .rowCount,
        6,
      );
      assert.equal(
        (await pool.query('SELECT * FROM delivery_item_contents')).rowCount,
        8,
      );
      assert.equal(
        (await pool.query('SELECT state FROM executions')).rows[0].state,
        'SUCCEEDED',
      );
      assert.equal(await h.make().runOne(), false);
      assert.equal(h.calls.length, 6);
    });
  },
);
test(
  '429 retry_after persists, retry skips sent prefix and continues album then suffix',
  options,
  async () => {
    await withDatabase(async (pool, owner) => {
      await seed(pool, owner);
      let failed = false;
      const h = wire(pool, async (c) => {
        if (c.ids.length === 2 && !failed) {
          failed = true;
          throw error(429, 60);
        }
      });
      await h.make().runOne();
      const d = (await pool.query('SELECT * FROM deliveries')).rows[0];
      assert.equal(d.state, 'FAILED_RETRYABLE');
      assert.equal(d.next_attempt_at.toISOString(), '2026-10-03T12:01:10.000Z');
      assert.equal(await h.make().runOne(), false);
      h.time('2026-10-03T12:01:10Z');
      await h.make().runOne();
      assert.deepEqual(
        h.calls.map((c) => c.ids),
        [[101], [102, 103], [102, 103], [104]],
      );
      assert.equal(
        (await pool.query('SELECT state FROM executions')).rows[0].state,
        'SUCCEEDED',
      );
    });
  },
);
test(
  'explicit 5xx retries stop at max attempts and retain successful prefix',
  options,
  async () => {
    await withDatabase(async (pool, owner) => {
      await seed(pool, owner);
      const h = wire(pool, async (c) => {
        if (c.ids.length === 2) throw error(503);
      });
      await h.make(2).runOne();
      h.time('2026-10-03T12:10:00Z');
      await h.make(2).runOne();
      const d = (await pool.query('SELECT * FROM deliveries')).rows[0];
      assert.equal(d.state, 'FAILED_PERMANENT');
      assert.equal(d.last_error_code, 'ATTEMPTS_EXHAUSTED');
      assert.equal(
        (await pool.query('SELECT state FROM executions')).rows[0].state,
        'PARTIAL_FAILED',
      );
      assert.equal(h.calls.filter((c) => c.ids[0] === 101).length, 1);
      assert.equal(await h.make().runOne(), false);
    });
  },
);
for (const mode of ['timeout', 'partial'] as const)
  test(
    `${mode} stops package as UNKNOWN with no automatic replay`,
    options,
    async () => {
      await withDatabase(async (pool, owner) => {
        await seed(pool, owner);
        const h = wire(pool, async (c) => {
          if (c.ids.length === 2) {
            if (mode === 'timeout') throw new Error('secret network details');
            return [{ message_id: 9001 }];
          }
        });
        await h.make().runOne();
        const d = (await pool.query('SELECT * FROM deliveries')).rows[0];
        assert.equal(d.state, 'UNKNOWN');
        assert.equal(d.last_error_message, null);
        assert.equal(h.calls.length, 2);
        assert.equal(await h.make().runOne(), false);
        const album = (
          await pool.query('SELECT * FROM delivery_items WHERE sequence=1')
        ).rows[0];
        assert.deepEqual(
          album.sent_message_ids,
          mode === 'partial' ? [9001] : [],
        );
        assert.equal(
          (await pool.query('SELECT state FROM executions')).rows[0].state,
          'PARTIAL_FAILED',
        );
      });
    },
  );
test(
  'a held advisory claim prevents competing workers from sending or treating live SENDING as orphan',
  options,
  async () => {
    await withDatabase(async (pool, owner) => {
      await seed(pool, owner);
      let release!: () => void, started!: () => void;
      const blocked = new Promise<void>((r) => {
        release = r;
      });
      const entered = new Promise<void>((r) => {
        started = r;
      });
      const h = wire(pool, async (_c, index) => {
        if (index === 1) {
          started();
          await blocked;
        }
      });
      const first = h.make().runOne();
      await entered;
      assert.equal(await h.make().runOne(), false);
      assert.equal(h.calls.length, 1);
      release();
      await first;
      assert.equal(h.calls.length, 3);
    });
  },
);
test(
  'crash after SENDING commit recovers UNKNOWN, while crash between SENT units resumes suffix',
  options,
  async () => {
    await withDatabase(async (pool, owner) => {
      await seed(pool, owner);
      const repo = new PgDeliveryRepository(pool);
      await assert.rejects(
        repo.runNext(now, async (s) => {
          await s.sending(s.units[0]!, '-2001');
          throw new Error('crash');
        }),
        /crash/,
      );
      const h = wire(pool);
      await h.make().runOne();
      assert.equal(h.calls.length, 0);
      assert.equal(
        (await pool.query('SELECT state FROM deliveries')).rows[0].state,
        'UNKNOWN',
      );
    });
    await withDatabase(async (pool, owner) => {
      await seed(pool, owner);
      const repo = new PgDeliveryRepository(pool);
      await assert.rejects(
        repo.runNext(now, async (s) => {
          await s.sending(s.units[0]!, '-2001');
          await s.sent(s.units[0]!, [1101]);
          throw new Error('crash');
        }),
        /crash/,
      );
      const h = wire(pool);
      await h.make().runOne();
      assert.deepEqual(
        h.calls.map((c) => c.ids),
        [[102, 103], [104]],
      );
      assert.equal(
        (await pool.query('SELECT state FROM executions')).rows[0].state,
        'SUCCEEDED',
      );
    });
  },
);
test(
  'DB failure recording a successful copy leaves SENDING and recovery never resends',
  options,
  async () => {
    await withDatabase(async (pool, owner) => {
      await seed(pool, owner);
      await pool.query(`CREATE FUNCTION fail_sent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='SENT' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_sent BEFORE UPDATE ON delivery_items FOR EACH ROW EXECUTE FUNCTION fail_sent()`);
      const h = wire(pool);
      await assert.rejects(h.make().runOne(), /injected failure/);
      assert.equal(h.calls.length, 1);
      await pool.query('DROP TRIGGER fail_sent ON delivery_items');
      await h.make().runOne();
      assert.equal(h.calls.length, 1);
      assert.equal(
        (await pool.query('SELECT state FROM deliveries')).rows[0].state,
        'UNKNOWN',
      );
    });
  },
);
test(
  'permanent target failure marks unreachable and does not prevent another target from succeeding',
  options,
  async () => {
    await withDatabase(async (pool, owner) => {
      await seed(pool, owner, 2);
      const h = wire(pool, async (c) => {
        if (c.chat === '-2001') throw error(403);
      });
      await Promise.all([h.make().runOne(), h.make().runOne()]);
      assert.equal(
        (
          await pool.query(
            'SELECT is_reachable FROM targets WHERE telegram_chat_id=-2001',
          )
        ).rows[0].is_reachable,
        false,
      );
      assert.equal(
        (await pool.query('SELECT state FROM executions')).rows[0].state,
        'PARTIAL_FAILED',
      );
    });
  },
);
test(
  'history is owner scoped, paginated, per reminder and retains old immutable name',
  options,
  async () => {
    await withDatabase(async (pool, owner, other) => {
      const data = await seed(pool, owner);
      const h = wire(pool);
      await h.make().runOne();
      const repo = new PgHistoryRepository(pool);
      assert.equal(
        (await repo.page(other, 0, data.reminder)).entries.length,
        0,
      );
      let page = await repo.page(owner, 0, data.reminder);
      assert.equal(page.entries[0]!.name, 'بستهٔ اصلی');
      assert.equal(page.entries[0]!.deliveries[0]!.sent, 3);
      for (let day = 4; day <= 9; day++)
        await new PgScheduleProducer(pool).tick(
          `2026-10-${String(day).padStart(2, '0')}T12:00:10Z`,
        );
      page = await repo.page(owner, 0);
      assert.equal(page.entries.length, 5);
      assert.equal(page.hasNext, true);
      assert.equal((await repo.page(owner, 1)).entries.length, 2);
      await pool.query(
        'UPDATE reminder_versions SET retired_at=$2 WHERE id=$1',
        [data.version, now],
      );
      const next = randomUUID();
      await pool.query(
        "INSERT INTO reminder_versions(id,reminder_id,version_no,name,timezone,activated_at) VALUES($1,$2,2,'نام تازه','UTC',$3)",
        [next, data.reminder, now],
      );
      await pool.query(
        'UPDATE reminders SET current_version_id=$2 WHERE id=$1',
        [data.reminder, next],
      );
      assert.ok(
        (await repo.page(owner, 0)).entries.every(
          (e) => e.name === 'بستهٔ اصلی',
        ),
      );
    });
  },
);
test(
  'pending old version cancels; an already started old-version execution finishes its original package',
  options,
  async () => {
    for (const started of [false, true])
      await withDatabase(async (pool, owner) => {
        const data = await seed(pool, owner);
        if (started)
          await assert.rejects(
            new PgDeliveryRepository(pool).runNext(now, async (s) => {
              await s.sending(s.units[0]!, '-2001');
              await s.sent(s.units[0]!, [1101]);
              throw new Error('stop');
            }),
          );
        await pool.query("UPDATE reminders SET status='PAUSED' WHERE id=$1", [
          data.reminder,
        ]);
        const h = wire(pool);
        await h.make().runOne();
        assert.equal(h.calls.length, started ? 2 : 0);
        assert.equal(
          (await pool.query('SELECT state FROM executions')).rows[0].state,
          started ? 'SUCCEEDED' : 'CANCELLED',
        );
      });
  },
);
