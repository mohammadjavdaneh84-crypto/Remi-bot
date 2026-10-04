import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GrammyError } from 'grammy';
import type { Pool } from 'pg';
import { PgDailyHeaders } from '../../src/infrastructure/db/daily-headers.js';
import { PgDailyHeaderWorker } from '../../src/infrastructure/db/daily-header-worker.js';
import {
  HeaderConflict,
  type HeaderTransport,
} from '../../src/app/daily-header/model.js';
import { pollingLease } from '../../src/infrastructure/db/polling-lease.js';
import { TargetUnavailable, Targets } from '../../src/app/services/targets.js';
import { createBot } from '../../src/infrastructure/telegram/bot.js';
import { PgTargetRepository } from '../../src/infrastructure/db/targets.js';
import { TelegramHeaderTransport } from '../../src/infrastructure/telegram/daily-header-transport.js';
import { Api } from 'grammy';
import { chat, admin } from '../helpers/phase2.js';
import { botInfo, snapshot } from '../helpers/phase2.js';
import { databaseUrl, withDatabase } from '../helpers/database.js';
import type { Update } from 'grammy/types';

const options = { skip: !databaseUrl };
const now = '2026-10-03T12:00:00Z';
async function seed(pool: Pool, owner: string, pin = true) {
  const repo = new PgDailyHeaders(pool);
  const s = await repo.begin(owner, now);
  s.payload = {
    ...s.payload,
    step: 'CONFIRM',
    timezone: 'UTC',
    localTime: '08:00',
    pin,
  };
  await repo.change(owner, 1, s, now, true);
  return (await repo.list(owner))[0]!;
}
function harness(
  pool: Pool,
  hook: (method: string) => Promise<void> = async () => {},
) {
  const calls: {
    method: string;
    chat: string;
    message?: number;
    date?: string;
  }[] = [];
  let time = now;
  let serial = 500;
  const transport: HeaderTransport = {
    check: async (_owner, _target, chat) => {
      await hook('check');
      return { chatId: chat, title: 'Destination' };
    },
    send: async (chat, date) => {
      calls.push({ method: 'send', chat, date });
      await hook('send');
      return ++serial;
    },
    pin: async (chat, message) => {
      calls.push({ method: 'pin', chat, message });
      await hook('pin');
    },
    unpin: async (chat, message) => {
      calls.push({ method: 'unpin', chat, message });
      await hook('unpin');
    },
  };
  return {
    calls,
    transport,
    time: (value: string) => {
      time = value;
    },
    make: () =>
      new PgDailyHeaderWorker(
        pool,
        transport,
        3,
        () => {},
        () => time,
      ),
  };
}
function telegramError(code: number, retryAfter = 60) {
  return new GrammyError(
    'test',
    {
      ok: false,
      error_code: code,
      description: 'controlled',
      parameters: { retry_after: retryAfter },
    },
    'sendMessage',
    {},
  );
}

test(
  'header transient failures stop at attempt cap; old-day retry never floods backlog',
  options,
  async () => {
    await withDatabase(async (pool, owner) => {
      await seed(pool, owner);
      const h = harness(pool, async (method) => {
        if (method === 'send') throw telegramError(503);
      });
      for (const time of [
        now,
        '2026-10-03T12:02:00Z',
        '2026-10-03T12:04:00Z',
      ]) {
        h.time(time);
        await h.make().runOne();
      }
      assert.equal(
        (await pool.query('SELECT state,attempt_count FROM daily_header_runs'))
          .rows[0].state,
        'FAILED',
      );
      assert.equal(await h.make().runOne(), false);
      h.time('2026-10-10T12:00:00Z');
      await h.make().runOne();
      h.time('2026-10-11T12:00:00Z');
      await h.make().runOne();
      const days = (
        await pool.query(
          'SELECT local_date::text AS date,state FROM daily_header_runs ORDER BY local_date',
        )
      ).rows;
      assert.deepEqual(
        days.map((r) => r.date),
        ['2026-10-03', '2026-10-10', '2026-10-11'],
      );
      assert.equal(days[1].state, 'CANCELLED');
    });
  },
);

test(
  'header activation rollback preserves draft and allows the same update to retry',
  options,
  async () => {
    await withDatabase(async (pool, owner) => {
      const repo = new PgDailyHeaders(pool);
      const s = await repo.begin(owner, now);
      s.payload.step = 'CONFIRM';
      await pool.query(`CREATE FUNCTION reject_header() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'activation failure'; END $$;
      CREATE TRIGGER reject_header BEFORE INSERT ON daily_header_configs FOR EACH ROW EXECUTE FUNCTION reject_header()`);
      await assert.rejects(
        repo.change(owner, 1, s, now, true),
        /activation failure/,
      );
      assert.equal((await repo.list(owner)).length, 0);
      assert.ok(await repo.draft(owner, now));
      await pool.query('DROP TRIGGER reject_header ON daily_header_configs');
      await repo.change(owner, 1, s, now, true);
      assert.equal((await repo.list(owner)).length, 1);
    });
  },
);

test(
  'header Telegram permission checks cover group/channel/private and migrated destination keeps one config',
  options,
  async () => {
    await withDatabase(async (pool, owner, other) => {
      const targets = new PgTargetRepository(pool);
      const old = await targets.save(owner, {
        ...snapshot,
        chatId: '-2001',
        type: 'group',
      });
      const repo = new PgDailyHeaders(pool);
      const s = await repo.begin(owner, now);
      s.payload = {
        ...s.payload,
        step: 'CONFIRM',
        targetId: old.id,
        chatId: old.chatId,
        title: old.title,
      };
      await repo.change(owner, 1, s, now, true);
      await targets.migrate(owner, '-2001', {
        ...snapshot,
        chatId: '-2002',
        type: 'supergroup',
      });
      const current = (await targets.byChat(owner, '-2002'))!;
      const duplicate = await repo.begin(owner, now);
      duplicate.payload = {
        ...duplicate.payload,
        step: 'CONFIRM',
        targetId: current.id,
        chatId: current.chatId,
        title: current.title,
      };
      await assert.rejects(
        repo.change(owner, 2, duplicate, now, true),
        /موجود/,
      );
      await repo.cancel(owner);
      const api = new Api('123:test');
      let pin = true;
      let channel = false;
      api.config.use(
        async (_prev, method, payload) =>
          ({
            ok: true,
            result:
              method === 'getChat'
                ? {
                    ...chat,
                    id: Number((payload as { chat_id: string }).chat_id),
                    type: channel ? 'channel' : 'supergroup',
                  }
                : {
                    ...admin,
                    can_post_messages: true,
                    can_pin_messages: pin,
                    can_edit_messages: pin,
                  },
          }) as never,
      );
      const transport = new TelegramHeaderTransport(pool, api, () => 456);
      assert.equal(
        (await transport.check(owner, old.id, old.chatId, true)).chatId,
        '-2002',
      );
      pin = false;
      await assert.rejects(
        transport.check(owner, old.id, old.chatId, true),
        TargetUnavailable,
      );
      assert.equal(
        (await transport.check(owner, old.id, old.chatId, false)).chatId,
        '-2002',
      );
      channel = true;
      await assert.rejects(
        transport.check(owner, old.id, old.chatId, true),
        TargetUnavailable,
      );
      pin = true;
      await transport.check(owner, old.id, old.chatId, true);
      await assert.rejects(
        transport.check(other, null, '123', true),
        TargetUnavailable,
      );
      await transport.check(owner, null, '123', true);
      const c = (await repo.list(owner))[0]!;
      const edit = await repo.begin(owner, now, c.id, c.revision);
      edit.payload = {
        ...edit.payload,
        step: 'CONFIRM',
        targetId: current.id,
        chatId: current.chatId,
        title: current.title,
      };
      await repo.change(owner, 3, edit, now, true);
      assert.equal((await repo.get(owner, c.id))!.chatId, '-2002');
    });
  },
);

test(
  'concurrent header workers dedupe each local day; next day unpins only previous own header',
  options,
  async () => {
    await withDatabase(async (pool, owner) => {
      await seed(pool, owner);
      const h = harness(pool);
      await Promise.all([
        h.make().runOne(),
        h.make().runOne(),
        h.make().runOne(),
      ]);
      assert.deepEqual(
        h.calls.map((c) => c.method),
        ['send', 'pin'],
      );
      assert.equal(await h.make().runOne(), false);
      h.time('2026-10-08T12:00:00Z');
      await h.make().runOne();
      assert.deepEqual(h.calls.slice(2), [
        { method: 'send', chat: '123', date: '2026-10-08' },
        { method: 'pin', chat: '123', message: 502 },
        { method: 'unpin', chat: '123', message: 501 },
      ]);
      assert.equal(
        (await pool.query('SELECT * FROM daily_header_runs')).rowCount,
        2,
      );
      assert.equal((await pool.query('SELECT * FROM executions')).rowCount, 0);
      assert.equal((await pool.query('SELECT * FROM targets')).rowCount, 0);
    });
  },
);
for (const stage of ['send', 'pin', 'unpin'])
  test(
    `header ${stage} 429 respects retry_after and never repeats a successful send`,
    options,
    async () => {
      await withDatabase(async (pool, owner) => {
        await seed(pool, owner);
        let reject = stage !== 'unpin';
        const h = harness(pool, async (method) => {
          if (method === stage && reject) throw telegramError(429);
        });
        await h.make().runOne();
        if (stage === 'unpin') {
          reject = true;
          h.time('2026-10-04T12:00:00Z');
          await h.make().runOne();
        }
        const count = h.calls.length;
        assert.equal(await h.make().runOne(), false);
        assert.equal(h.calls.length, count);
        reject = false;
        h.time(
          stage === 'unpin' ? '2026-10-04T12:02:00Z' : '2026-10-03T12:02:00Z',
        );
        await h.make().runOne();
        assert.equal(
          h.calls.filter((c) => c.method === 'send').length,
          stage === 'pin' ? 1 : 2,
        );
        assert.ok(
          (await pool.query('SELECT state FROM daily_header_runs')).rows.every(
            (r) => r.state === 'SUCCEEDED',
          ),
        );
      });
    },
  );
test(
  'ambiguous send and DB failure after send stop as UNKNOWN across restart',
  options,
  async () => {
    for (const databaseFailure of [false, true])
      await withDatabase(async (pool, owner) => {
        await seed(pool, owner);
        if (databaseFailure)
          await pool.query(`CREATE FUNCTION fail_header_result() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.message_id IS NOT NULL THEN RAISE EXCEPTION 'test save failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_header_result BEFORE UPDATE ON daily_header_runs FOR EACH ROW EXECUTE FUNCTION fail_header_result()`);
        const h = harness(pool, async (method) => {
          if (method === 'send' && !databaseFailure)
            throw new Error('network secret');
        });
        if (databaseFailure) {
          await assert.rejects(h.make().runOne(), /test save failure/);
          await pool.query(
            'DROP TRIGGER fail_header_result ON daily_header_runs',
          );
          await h.make().runOne();
        } else await h.make().runOne();
        assert.equal(
          (await pool.query('SELECT state FROM daily_header_runs')).rows[0]
            .state,
          'UNKNOWN',
        );
        await h.make().runOne();
        assert.equal(h.calls.filter((c) => c.method === 'send').length, 1);
        assert.equal(h.calls.filter((c) => c.method === 'pin').length, 0);
      });
  },
);
test(
  'DB failure after successful pin safely retries pin without sending again or unpinning unrelated messages',
  options,
  async () => {
    await withDatabase(async (pool, owner) => {
      await seed(pool, owner);
      await pool.query(`CREATE FUNCTION fail_header_pin() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.stage='UNPIN' THEN RAISE EXCEPTION 'pin save failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_header_pin BEFORE UPDATE ON daily_header_runs FOR EACH ROW EXECUTE FUNCTION fail_header_pin()`);
      const h = harness(pool);
      await assert.rejects(h.make().runOne(), /pin save failure/);
      await pool.query('DROP TRIGGER fail_header_pin ON daily_header_runs');
      await h.make().runOne();
      assert.deepEqual(
        h.calls.map((c) => c.method),
        ['send', 'pin', 'pin'],
      );
      assert.equal(
        (await pool.query('SELECT state FROM daily_header_runs')).rows[0].state,
        'SUCCEEDED',
      );
    });
  },
);
test(
  'permission loss is recorded; another config still succeeds; send-only never pins',
  options,
  async () => {
    await withDatabase(async (pool, owner, other) => {
      await seed(pool, owner);
      await seed(pool, other, false);
      const h = harness(pool);
      h.transport.check = async (o, _t, chat) => {
        if (o === owner) throw new TargetUnavailable('denied');
        return { chatId: chat, title: 'Private' };
      };
      await h.make().runOne();
      await h.make().runOne();
      assert.deepEqual(
        h.calls.map((c) => c.method),
        ['send'],
      );
      assert.equal(h.calls[0]!.chat, '999');
      const rows = (
        await pool.query(
          'SELECT state,last_error_code FROM daily_header_runs ORDER BY state',
        )
      ).rows;
      assert.deepEqual(
        rows.map((r) => r.state),
        ['FAILED', 'SUCCEEDED'],
      );
      assert.equal(rows[0].last_error_code, 'TARGET_UNAVAILABLE');
    });
  },
);
test(
  'pause/resume skips pause, stale revisions and foreign owners are rejected, drafts persist/cancel',
  options,
  async () => {
    await withDatabase(async (pool, owner, other) => {
      const c = await seed(pool, owner);
      const repo = new PgDailyHeaders(pool);
      await assert.rejects(
        repo.toggle(other, c.id, 0, false, now),
        HeaderConflict,
      );
      await repo.toggle(owner, c.id, 0, false, now);
      await assert.rejects(
        repo.toggle(owner, c.id, 0, true, now),
        HeaderConflict,
      );
      await repo.toggle(owner, c.id, 1, true, now);
      const h = harness(pool);
      assert.equal(await h.make().runOne(), false);
      h.time('2026-10-04T08:00:00Z');
      await h.make().runOne();
      assert.equal(h.calls.filter((c) => c.method === 'send').length, 1);
      const s = await repo.begin(owner, now, c.id, 2);
      s.payload.localTime = '09:00';
      await repo.change(owner, 10, s, now);
      assert.equal(
        (await new PgDailyHeaders(pool).draft(owner, now))!.payload.localTime,
        '09:00',
      );
      await repo.cancel(owner);
      assert.equal((await repo.get(owner, c.id))!.localTime, '08:00');
      assert.equal(await repo.get(other, c.id), null);
      assert.deepEqual(await repo.history(other, c.id), []);
    });
  },
);
test(
  'save is atomic, edits preserve same-day receipt, duplicate destination is refused',
  options,
  async () => {
    await withDatabase(async (pool, owner) => {
      const c = await seed(pool, owner);
      const h = harness(pool);
      await h.make().runOne();
      const repo = new PgDailyHeaders(pool);
      const s = await repo.begin(owner, now, c.id, 0);
      s.payload.step = 'CONFIRM';
      s.payload.localTime = '09:00';
      await Promise.allSettled([
        repo.change(owner, 2, s, now, true),
        repo.change(owner, 3, s, now, true),
      ]);
      assert.equal((await repo.get(owner, c.id))!.revision, 1);
      await h.make().runOne();
      assert.equal(h.calls.filter((c) => c.method === 'send').length, 1);
      const duplicate = await repo.begin(owner, now);
      duplicate.payload.step = 'CONFIRM';
      await assert.rejects(
        repo.change(owner, 4, duplicate, now, true),
        /موجود/,
      );
      assert.equal((await repo.list(owner)).length, 1);
      assert.ok(await repo.draft(owner, now));
    });
  },
);
test(
  'configuration changes cannot overtake a live send; process restart preserves message receipt',
  options,
  async () => {
    await withDatabase(async (pool, owner) => {
      const c = await seed(pool, owner);
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>((r) => {
        entered = r;
      });
      const wait = new Promise<void>((r) => {
        release = r;
      });
      const h = harness(pool, async (method) => {
        if (method === 'send') {
          entered();
          await wait;
        }
      });
      const running = h.make().runOne();
      await started;
      assert.equal(await h.make().runOne(), false);
      await assert.rejects(
        new PgDailyHeaders(pool).toggle(owner, c.id, 0, false, now),
        HeaderConflict,
      );
      release();
      await running;
      assert.equal(await h.make().runOne(), false);
      assert.equal(h.calls.filter((c) => c.method === 'send').length, 1);
    });
  },
);
test(
  'polling handoff has one owner, supports cancellation and releases for next deployment',
  options,
  async () => {
    await withDatabase(async (pool) => {
      const first = await pollingLease(
        pool,
        456,
        new AbortController().signal,
        () => assert.fail('unexpected disconnect'),
      );
      const controller = new AbortController();
      const waiting = pollingLease(pool, 456, controller.signal, () => {});
      const rejected = assert.rejects(waiting);
      controller.abort();
      await rejected;
      await first();
      const second = await pollingLease(
        pool,
        456,
        new AbortController().signal,
        () => {},
      );
      await second();
    });
  },
);

test(
  'Persian daily wizard supports private/group/channel, restart, stale callbacks, cancel and owner gate',
  options,
  async () => {
    await withDatabase(async (pool, owner) => {
      const targetRepo = new PgTargetRepository(pool);
      const group = await targetRepo.save(owner, {
        ...snapshot,
        chatId: '-2002',
        type: 'supergroup',
        title: 'Group',
      });
      const channel = await targetRepo.save(owner, {
        ...snapshot,
        chatId: '-2003',
        type: 'channel',
        title: 'Channel',
      });
      const targets = new Targets(owner, targetRepo, {
        inspect: async (chatId) => ({
          ...snapshot,
          chatId,
          type: chatId === '-2002' ? 'supergroup' : 'channel',
        }),
      });
      const h = harness(pool);
      const replies: {
        text: string;
        reply_markup?: {
          inline_keyboard: { text: string; callback_data: string }[][];
        };
      }[] = [];
      let update = 100;
      const make = () => {
        const bot = createBot('123:test', '123', () => ({
          targets,
          storageChatId: '-1001',
          dailyHeaders: {
            repository: new PgDailyHeaders(pool),
            ownerId: owner,
            transport: h.transport,
          },
        }));
        bot.botInfo = botInfo;
        bot.api.config.use(async (_prev, method, payload) => {
          if (method === 'sendMessage') replies.push(payload as never);
          return { ok: true, result: true } as never;
        });
        return bot;
      };
      let bot = make();
      const click = async (data: string, user = 123) =>
        bot.handleUpdate({
          update_id: ++update,
          callback_query: {
            id: String(update),
            from: { id: user, is_bot: false, first_name: 'Owner' },
            chat_instance: 'private',
            data,
            message: {
              message_id: 1,
              date: 1,
              chat: { id: user, type: 'private', first_name: 'Owner' },
              text: 'menu',
            },
          },
        } as Update);
      const button = (text: string) =>
        replies
          .at(-1)!
          .reply_markup!.inline_keyboard.flat()
          .find((b) => b.text.includes(text))!.callback_data;
      const send = async (text: string) =>
        bot.handleUpdate({
          update_id: ++update,
          message: {
            message_id: update,
            date: 1,
            chat: { id: 123, type: 'private', first_name: 'Owner' },
            from: { id: 123, is_bot: false, first_name: 'Owner' },
            text,
            ...(text.startsWith('/')
              ? {
                  entities: [
                    { type: 'bot_command', offset: 0, length: text.length },
                  ],
                }
              : {}),
          },
        } as Update);
      await click('dh:new', 999);
      assert.equal(
        await new PgDailyHeaders(pool).draft(owner, new Date().toISOString()),
        null,
      );
      for (const destination of ['پیوی', 'Group', 'Channel']) {
        await click('dh:new');
        const stale = button(destination);
        await click(stale);
        await click(stale);
        assert.match(replies.at(-1)!.text, /قدیمی/);
        await send('۰۸:۳۰');
        bot = make();
        await send('/daily');
        await click(button('همین منطقه'));
        await click(button('ارسال و پین'));
        for (const b of replies.at(-1)!.reply_markup!.inline_keyboard.flat())
          assert.ok(Buffer.byteLength(b.callback_data) <= 64);
        await click(button('ذخیره'));
      }
      const configs = await new PgDailyHeaders(pool).list(owner);
      assert.equal(configs.length, 3);
      assert.deepEqual(
        new Set(configs.map((c) => c.targetId)),
        new Set([null, group.id, channel.id]),
      );
      await click('dh:new');
      await send('/cancel');
      assert.equal(
        await new PgDailyHeaders(pool).draft(owner, new Date().toISOString()),
        null,
      );
    });
  },
);
