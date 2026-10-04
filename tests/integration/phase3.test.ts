import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import type { Message } from 'grammy/types';
import { CreationWizard } from '../../src/app/wizard/service.js';
import { PgWizardRepository } from '../../src/infrastructure/db/wizard.js';
import { PgArchiveRepository } from '../../src/infrastructure/db/archives.js';
import { PgTargetRepository } from '../../src/infrastructure/db/targets.js';
import { ContentCapture } from '../../src/infrastructure/telegram/storage/capture.js';
import { Targets } from '../../src/app/services/targets.js';
import type { View, WizardInput } from '../../src/app/wizard/model.js';
import { databaseUrl, withDatabase } from '../helpers/database.js';
import {
  fakeApi,
  mediaMessage,
  textMessage,
  snapshot,
} from '../helpers/phase2.js';
import { findButton } from '../helpers/wizard.js';

async function harness(pool: Pool, owner: string) {
  const targetRepo = new PgTargetRepository(pool);
  const target = await targetRepo.save(owner, {
    ...snapshot,
    chatId: '-2001',
    title: 'Group A',
  });
  const second = await targetRepo.save(owner, {
    ...snapshot,
    chatId: '-2002',
    title: 'Channel B',
  });
  const targets = new Targets(owner, targetRepo, {
    inspect: async (id) => ({
      ...snapshot,
      chatId: id,
      title: id === '-2001' ? 'Group A' : 'Channel B',
    }),
  });
  const { api, calls } = fakeApi();
  const archive = new ContentCapture(
    api,
    new PgArchiveRepository(pool),
    owner,
    '123',
    '-1001',
    () => 456,
  );
  let now = '2026-10-03T00:00:00Z',
    seq = 0,
    view: View | null = null;
  const make = () =>
    new CreationWizard(
      owner,
      new PgWizardRepository(pool),
      targets,
      { archive: (p) => archive.archiveUnit(p as Message[]) },
      () => now,
    );
  let wizard = make();
  return {
    target,
    second,
    calls,
    make,
    get view() {
      return view;
    },
    get nextId() {
      return seq + 1;
    },
    restart: () => {
      wizard = make();
    },
    time: (value: string) => {
      now = value;
    },
    send: async (input: WizardInput) => {
      const response = await wizard.handle(++seq, input);
      if (response) view = response;
      return response;
    },
    click: async (action: string, arg?: string) => {
      view = await wizard.handle(++seq, {
        type: 'callback',
        data: findButton(view, action, arg),
      });
      return view;
    },
    explicit: (id: number, input: WizardInput) => wizard.handle(id, input),
  };
}
function incoming(message: Message): WizardInput {
  return {
    type: 'message',
    text: message.text ?? null,
    messageId: message.message_id,
    groupKey:
      'media_group_id' in message ? (message.media_group_id ?? null) : null,
    payload: message,
  };
}
async function content(h: Awaited<ReturnType<typeof harness>>, album = false) {
  await h.send({ type: 'start' });
  await h.send({ type: 'text', text: 'یادآور فارسی' });
  await h.send(incoming(textMessage()));
  if (album) {
    await h.send(incoming(mediaMessage('video', 2, 'album')));
    await h.send(incoming(mediaMessage('photo', 3, 'album')));
    h.time('2026-10-03T00:00:02Z');
  }
  await h.click('content_done');
}
async function toPreview(
  h: Awaited<ReturnType<typeof harness>>,
  complex = false,
) {
  await content(h, complex);
  await h.click('type', 'WEEKLY');
  await h.click('answer', '5');
  await h.click('answer', 'done');
  for (const text of ['2', '18:00', '2026-10-09'])
    await h.send({ type: 'text', text });
  await h.click('answer', 'AFTER_N_EXECUTIONS');
  await h.send({ type: 'text', text: '5' });
  await h.click('rule_save');
  if (complex) {
    await h.click('rule_add');
    await h.click('type', 'MONTHLY');
    await h.click('answer', 'DAY');
    for (const text of ['3', '1', '18:00', '2026-10-01'])
      await h.send({ type: 'text', text });
    await h.click('answer', 'UNLIMITED');
    await h.click('rule_save');
  }
  await h.click('targets');
  await h.click('target', '0');
  if (complex) await h.click('target', '1');
  await h.click('preview');
  assert.match(h.view!.text, /پیش‌نمایش یادآور/);
}
const options = { skip: !databaseUrl };
test(
  'Phase 3 end-to-end: text/video/photo, weekly + monthly rules, two targets, atomic version/cursors',
  options,
  async () => {
    await withDatabase(async (pool, owner) => {
      const h = await harness(pool, owner);
      await toPreview(h, true);
      assert.equal((await pool.query('SELECT * FROM reminders')).rowCount, 0);
      await h.click('confirm');
      assert.match(h.view!.text, /ساخته و ذخیره شد/);
      const reminder = (await pool.query('SELECT * FROM reminders')).rows[0];
      assert.equal(reminder.status, 'ACTIVE');
      const version = (await pool.query('SELECT * FROM reminder_versions'))
        .rows[0];
      assert.equal(reminder.current_version_id, version.id);
      assert.equal(version.name, 'یادآور فارسی');
      assert.equal(version.version_no, 1);
      assert.equal(version.missed_run_policy, 'LATEST_ONLY');
      assert.equal(
        (await pool.query('SELECT * FROM schedule_rules')).rowCount,
        2,
      );
      assert.equal(
        (await pool.query('SELECT * FROM reminder_version_targets')).rowCount,
        2,
      );
      const items = (
        await pool.query(
          'SELECT c.position,i.content_type,i.media_group_key FROM content_items c JOIN archived_content_items i ON (c.archive_id,c.archive_position)=(i.archive_id,i.position) ORDER BY c.position',
        )
      ).rows;
      assert.deepEqual(
        items.map((r) => r.content_type),
        ['text', 'video', 'photo'],
      );
      assert.equal(items[1].media_group_key, items[2].media_group_key);
      const cursors = (await pool.query('SELECT * FROM schedule_cursors')).rows;
      assert.ok(
        cursors.every(
          (r) =>
            r.active && r.consumed_count === 0 && r.next_due_at instanceof Date,
        ),
      );
      assert.equal(
        (await pool.query('SELECT active FROM reminder_drafts')).rows[0].active,
        false,
      );
      assert.equal(
        (await pool.query('SELECT status FROM wizard_sessions')).rows[0].status,
        'COMMITTED',
      );
      assert.ok(
        h.calls
          .filter((c) => c.method.startsWith('copy'))
          .every((c) => c.payload.chat_id === '-1001'),
      );
    });
  },
);
test(
  'concurrent and replayed confirmations create one reminder',
  options,
  async () => {
    await withDatabase(async (pool, owner) => {
      const h = await harness(pool, owner);
      await toPreview(h);
      const input: WizardInput = {
        type: 'callback',
        data: findButton(h.view, 'confirm'),
      };
      await Promise.all([h.explicit(900, input), h.make().handle(901, input)]);
      assert.equal(await h.explicit(900, input), null);
      assert.equal((await pool.query('SELECT * FROM reminders')).rowCount, 1);
      assert.equal(
        (await pool.query('SELECT * FROM reminder_versions')).rowCount,
        1,
      );
    });
  },
);
test(
  'failed cursor insert rolls back entire activation and confirmation can be retried',
  options,
  async () => {
    await withDatabase(async (pool, owner) => {
      const h = await harness(pool, owner);
      await toPreview(h);
      const callback = findButton(h.view, 'confirm');
      await pool.query(
        "CREATE FUNCTION fail_cursor() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$; CREATE TRIGGER fail_cursor BEFORE INSERT ON schedule_cursors FOR EACH ROW EXECUTE FUNCTION fail_cursor()",
      );
      await h.send({ type: 'callback', data: callback });
      assert.match(h.view!.text, /موقتاً ناموفق/);
      for (const table of [
        'reminders',
        'reminder_versions',
        'content_items',
        'schedule_rules',
        'schedule_cursors',
        'reminder_version_targets',
      ])
        assert.equal((await pool.query(`SELECT * FROM ${table}`)).rowCount, 0);
      assert.equal(
        (await pool.query('SELECT status FROM wizard_sessions')).rows[0].status,
        'ACTIVE',
      );
      assert.equal(
        (await pool.query('SELECT active FROM reminder_drafts')).rows[0].active,
        true,
      );
      await pool.query('DROP TRIGGER fail_cursor ON schedule_cursors');
      await h.send({ type: 'callback', data: callback });
      assert.equal((await pool.query('SELECT * FROM reminders')).rowCount, 1);
    });
  },
);
test(
  'crash boundary after archive but before draft save recovers without another Telegram copy',
  options,
  async () => {
    await withDatabase(async (pool, owner) => {
      const h = await harness(pool, owner);
      await h.send({ type: 'start' });
      await h.send({ type: 'text', text: 'recover' });
      await h.send(incoming(textMessage()));
      const done = findButton(h.view, 'content_done');
      await pool.query(
        "CREATE FUNCTION fail_draft() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF jsonb_array_length(NEW.payload->'archives')>0 THEN RAISE EXCEPTION 'test failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_draft BEFORE UPDATE ON reminder_drafts FOR EACH ROW EXECUTE FUNCTION fail_draft()",
      );
      await h.send({ type: 'callback', data: done });
      assert.equal(
        (await pool.query("SELECT * FROM content_archives WHERE state='READY'"))
          .rowCount,
        1,
      );
      assert.equal(
        (await pool.query('SELECT payload FROM reminder_drafts')).rows[0]
          .payload.pending.length,
        1,
      );
      await pool.query('DROP TRIGGER fail_draft ON reminder_drafts');
      h.restart();
      await h.send({ type: 'callback', data: done });
      assert.equal(
        (await pool.query('SELECT step FROM wizard_sessions')).rows[0].step,
        'RULE_TYPE',
      );
      assert.equal(h.calls.filter((c) => c.method === 'copyMessage').length, 1);
    });
  },
);
test(
  'restart keeps album inbox, form and timezone; expired session cannot be used',
  options,
  async () => {
    await withDatabase(async (pool, owner) => {
      const h = await harness(pool, owner);
      await pool.query(
        "UPDATE users SET default_timezone='Asia/Tehran' WHERE id=$1",
        [owner],
      );
      await h.send({ type: 'start' });
      await h.send({ type: 'text', text: 'restart' });
      await h.send(incoming(mediaMessage('photo', 1, 'a')));
      h.restart();
      await h.send(incoming(mediaMessage('video', 2, 'a')));
      h.time('2026-10-03T00:00:02Z');
      await h.send({ type: 'start' });
      await h.click('content_done');
      await h.click('type', 'WEEKLY');
      await h.click('answer', '5');
      await pool.query("UPDATE users SET default_timezone='UTC' WHERE id=$1", [
        owner,
      ]);
      h.restart();
      await h.send({ type: 'start' });
      assert.match(h.view!.text, /☑|چه روزهایی/);
      const draft = (await pool.query('SELECT payload FROM reminder_drafts'))
        .rows[0].payload;
      assert.equal(draft.timezone, 'Asia/Tehran');
      assert.equal(draft.archives[0].count, 2);
      const old = findButton(h.view, 'answer', 'done');
      h.time('2026-10-05T00:00:00Z');
      await h.send({ type: 'callback', data: old });
      assert.equal(
        (await pool.query('SELECT status FROM wizard_sessions')).rows[0].status,
        'EXPIRED',
      );
      assert.equal(
        (await pool.query('SELECT active FROM reminder_drafts')).rows[0].active,
        false,
      );
      await h.send({ type: 'start' });
      assert.equal(
        (await pool.query('SELECT * FROM wizard_sessions')).rowCount,
        2,
      );
    });
  },
);
test(
  'cancel preserves archived content and already active reminders',
  options,
  async () => {
    await withDatabase(async (pool, owner) => {
      const h = await harness(pool, owner);
      await toPreview(h);
      await h.click('confirm');
      await h.send({ type: 'start' });
      await h.send({ type: 'text', text: 'cancel' });
      await h.send(incoming(textMessage(10)));
      await h.click('content_done');
      await h.send({ type: 'cancel' });
      assert.equal(
        (await pool.query("SELECT * FROM reminders WHERE status='ACTIVE'"))
          .rowCount,
        1,
      );
      assert.equal(
        (await pool.query("SELECT * FROM content_archives WHERE state='READY'"))
          .rowCount,
        2,
      );
      assert.equal(
        (await pool.query('SELECT * FROM reminder_drafts WHERE active'))
          .rowCount,
        0,
      );
    });
  },
);
test(
  'ownership checks reject forged target/archive references and foreign callback token',
  options,
  async () => {
    await withDatabase(async (pool, owner, other) => {
      const h = await harness(pool, owner);
      await toPreview(h);
      const callback = findButton(h.view, 'confirm');
      const foreign = await new PgTargetRepository(pool).save(other, snapshot);
      const otherWizard = new CreationWizard(
        other,
        new PgWizardRepository(pool),
        new Targets(other, new PgTargetRepository(pool), {
          inspect: async () => snapshot,
        }),
        {
          archive: async () => {
            throw new Error('unused');
          },
        },
      );
      await otherWizard.handle(1000, { type: 'callback', data: callback });
      assert.equal((await pool.query('SELECT * FROM reminders')).rowCount, 0);
      await pool.query(
        "UPDATE reminder_drafts SET payload=jsonb_set(payload,'{targets}',$1::jsonb) WHERE owner_user_id=$2",
        [JSON.stringify([{ id: foreign.id, title: 'forged' }]), owner],
      );
      await h.send({ type: 'callback', data: callback });
      assert.equal((await pool.query('SELECT * FROM reminders')).rowCount, 0);
      await pool.query(
        "UPDATE reminder_drafts SET payload=jsonb_set(payload,'{targets}',$1::jsonb) WHERE owner_user_id=$2",
        [JSON.stringify([{ id: h.target.id, title: 'Group A' }]), owner],
      );
      await pool.query(
        'UPDATE content_archives SET owner_user_id=$1 WHERE owner_user_id=$2',
        [other, owner],
      );
      await h.send({ type: 'callback', data: callback });
      assert.equal((await pool.query('SELECT * FROM reminders')).rowCount, 0);
    });
  },
);
test(
  'activated definitions cannot be changed, but runtime cursor is mutable',
  options,
  async () => {
    await withDatabase(async (pool, owner) => {
      const h = await harness(pool, owner);
      await toPreview(h);
      await h.click('confirm');
      await assert.rejects(
        pool.query("UPDATE reminder_versions SET name='changed'"),
        /immutable/,
      );
      await assert.rejects(
        pool.query('UPDATE schedule_rules SET enabled=false'),
        /immutable/,
      );
      await assert.rejects(
        pool.query('DELETE FROM content_items'),
        /immutable/,
      );
      await assert.rejects(
        pool.query('DELETE FROM reminder_version_targets'),
        /immutable/,
      );
      await pool.query('UPDATE schedule_cursors SET consumed_count=1');
      await assert.rejects(
        pool.query('UPDATE schedule_cursors SET consumed_count=-1'),
      );
      assert.equal(
        (await pool.query('SELECT consumed_count FROM schedule_cursors'))
          .rows[0].consumed_count,
        1,
      );
    });
  },
);
