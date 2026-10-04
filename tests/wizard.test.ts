import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CreationWizard } from '../src/app/wizard/service.js';
import { Targets } from '../src/app/services/targets.js';
import { ContentCapture } from '../src/infrastructure/telegram/storage/capture.js';
import type { Message } from 'grammy/types';
import type { View, WizardInput } from '../src/app/wizard/model.js';
import { steps } from '../src/app/wizard/model.js';
import { createBot } from '../src/infrastructure/telegram/bot.js';
import { captureEnvelope } from '../src/infrastructure/telegram/wizard.js';
import { MemoryWizardRepository, findButton } from './helpers/wizard.js';
import {
  MemoryTargets,
  MemoryArchives,
  fakeApi,
  textMessage,
  mediaMessage,
  snapshot,
  botInfo,
} from './helpers/phase2.js';

async function setup() {
  const repo = new MemoryWizardRepository(),
    targetRepo = new MemoryTargets(),
    archives = new MemoryArchives();
  await targetRepo.save('owner', snapshot);
  const targets = new Targets('owner', targetRepo, {
    inspect: async () => snapshot,
  });
  const { api, calls } = fakeApi();
  const capture = new ContentCapture(
    api,
    archives,
    'owner',
    '123',
    '-1001',
    () => 456,
  );
  let now = '2026-10-03T00:00:00Z',
    seq = 0;
  const create = () =>
    new CreationWizard(
      'owner',
      repo,
      targets,
      { archive: (m) => capture.archiveUnit(m as Message[]) },
      () => now,
    );
  let wizard = create(),
    view: View | null = null;
  return {
    repo,
    targetRepo,
    archives,
    calls,
    targets,
    instance: () => wizard,
    get view() {
      return view;
    },
    get session() {
      return repo.sessions.get('owner')!;
    },
    time: (value: string) => {
      now = value;
    },
    restart: () => {
      wizard = create();
    },
    send: async (input: WizardInput) => {
      view = await wizard.handle(++seq, input);
      return view;
    },
    click: async (action: string, arg?: string) => {
      view = await wizard.handle(++seq, {
        type: 'callback',
        data: findButton(view, action, arg),
      });
      return view;
    },
    replay: async (id: number, input: WizardInput) => wizard.handle(id, input),
  };
}
const incoming = (m: Message): WizardInput => ({
  type: 'message',
  text: m.text ?? null,
  messageId: m.message_id,
  groupKey: 'media_group_id' in m ? (m.media_group_id ?? null) : null,
  payload: m,
});
async function toRules(s: Awaited<ReturnType<typeof setup>>) {
  await s.send({ type: 'start' });
  await s.send({ type: 'text', text: 'یادآور آزمایشی' });
  await s.send(incoming(textMessage()));
  await s.click('content_done');
}
async function addDaily(s: Awaited<ReturnType<typeof setup>>) {
  await s.click('type', 'EVERY_N_DAYS');
  for (const text of ['2', '18:00', '2026-10-09'])
    await s.send({ type: 'text', text });
  await s.click('answer', 'UNLIMITED');
  await s.click('rule_save');
}

test('management draft rule editor is prefilled; copy, toggle and settings are isolated until save', async () => {
  const s = await setup();
  await toRules(s);
  await addDaily(s);
  const original = structuredClone(s.session.draft.rules[0]!);
  await s.click('rule_change', '0');
  assert.match(s.view!.text, /مقدار فعلی: 2/);
  await s.click('keep');
  await s.send({ type: 'text', text: '19:30' });
  await s.click('keep');
  await s.click('keep');
  await s.click('rule_save');
  assert.equal(s.session.draft.rules.length, 1);
  const rule = s.session.draft.rules[0]!;
  assert.equal(rule.id, original.id);
  assert.equal(rule.config.type, 'EVERY_N_DAYS');
  if (rule.config.type === 'EVERY_N_DAYS')
    assert.equal(rule.config.localTime, '19:30');
  await s.click('rule_duplicate', '0');
  assert.notEqual(s.session.draft.rules[1]!.id, rule.id);
  await s.click('rule_toggle', '1');
  assert.equal(s.session.draft.rules[1]!.enabled, false);
  assert.notEqual(s.session.draft.rules[0]!.enabled, false);
  await s.click('rule_remove', '1');
  await s.click('targets');
  await s.click('target', '0');
  await s.click('preview');
  await s.click('timezone');
  await s.send({ type: 'text', text: 'Europe/Berlin' });
  assert.equal(s.session.draft.timezone, 'Europe/Berlin');
  await s.click('missed_policy');
  await s.click('policy', 'SKIP');
  assert.equal(s.session.draft.missedPolicy, 'SKIP');
  assert.equal(s.repo.commits, 0);
});

test('content replacement preserves the old canonical reference on failure and swaps only after successful capture', async () => {
  const s = await setup();
  await toRules(s);
  const original = s.session.draft.archives[0]!.id;
  s.session.step = 'CONTENT';
  await s.send({ type: 'start' });
  await s.click('content_caption', '0');
  await s.send(incoming({ ...textMessage(2), has_protected_content: true }));
  await s.click('content_done');
  assert.equal(s.session.draft.archives[0]!.id, original);
  assert.equal(s.session.work.replacingContent, 0);
  await s.click('drop_failed');
  await s.send(incoming({ ...textMessage(3), text: 'متن اصلاح‌شده' }));
  await s.click('content_done');
  assert.notEqual(s.session.draft.archives[0]!.id, original);
  assert.equal(s.session.draft.archives.length, 1);
  assert.equal(s.archives.entries.get(original)!.state, 'READY');
  s.session.step = 'CONTENT';
  await s.send({ type: 'start' });
  await s.send(incoming(textMessage(4)));
  await s.click('content_done');
  s.session.step = 'CONTENT';
  await s.send({ type: 'start' });
  const ids = s.session.draft.archives.map((a) => a.id);
  await s.click('content_up', '1');
  assert.deepEqual(
    s.session.draft.archives.map((a) => a.id),
    ids.reverse(),
  );
  await s.click('content_remove', '1');
  assert.equal(s.session.draft.archives.length, 1);
});

test('content editor paginates buttons and allows replacement at the 100-item limit', async () => {
  const s = await setup();
  await toRules(s);
  const archive = s.session.draft.archives[0]!;
  s.session.draft.archives = Array.from({ length: 100 }, () =>
    structuredClone(archive),
  );
  s.session.step = 'CONTENT';
  await s.send({ type: 'start' });
  assert.ok(s.view!.buttons.flat().length < 70);
  await s.click('content_page', '1');
  assert.ok(
    s.view!.buttons.flat().some((b) => b.data.endsWith(':content_replace:10')),
  );
  await s.click('content_replace', '10');
  await s.send(incoming(textMessage(22)));
  assert.equal(s.session.draft.pending.length, 1);
  assert.equal(s.session.draft.archives.length, 100);
  await s.click('content_abort');
  assert.equal(s.session.draft.pending.length, 0);
  assert.equal(s.session.draft.archives.length, 100);
});
test('full creation with preview, two rules and selected target only commits on confirm', async () => {
  const s = await setup();
  await toRules(s);
  await addDaily(s);
  await s.click('rule_add');
  await s.click('type', 'ONE_TIME');
  await s.send({ type: 'text', text: '2026-10-10' });
  await s.send({ type: 'text', text: '19:00' });
  await s.click('rule_save');
  await s.click('targets');
  await s.click('target', '0');
  await s.click('preview');
  assert.equal(s.repo.commits, 0);
  assert.equal(s.session.step, 'PREVIEW');
  assert.match(s.view!.text, /Asia\/Tehran/);
  assert.match(s.view!.text, /Target/);
  assert.match(s.view!.text, /اجراهای آینده/);
  assert.equal(s.session.draft.rules.length, 2);
  const old = findButton(s.view, 'confirm');
  await s.click('confirm');
  assert.equal(s.repo.commits, 1);
  await s.send({ type: 'callback', data: old });
  assert.equal(s.repo.commits, 1);
});
test('Telegram adapter routes text by persisted state, enforces owner and handles cancel callback', async () => {
  const s = await setup();
  const bot = createBot('123:test-token', '123', () => ({
    targets: s.targets,
    storageChatId: '-1001',
    wizard: s.instance(),
  }));
  bot.botInfo = botInfo;
  const sent: Record<string, unknown>[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    if (method === 'sendMessage') sent.push(payload);
    return { ok: true, result: true } as never;
  });
  const message = (text: string, id: number) => ({
    ...textMessage(id),
    chat: { id: 123, type: 'private' as const, first_name: 'Owner' },
    from: { id: 123, is_bot: false, first_name: 'Owner' },
    text,
    ...(text.startsWith('/')
      ? {
          entities: [
            { type: 'bot_command' as const, offset: 0, length: text.length },
          ],
        }
      : {}),
  });
  await bot.handleUpdate({ update_id: 1, message: message('/new', 1) });
  await bot.handleUpdate({ update_id: 2, message: message('نام جدید', 2) });
  assert.equal(s.session.step, 'CONTENT');
  assert.equal(s.session.draft.name, 'نام جدید');
  await bot.handleUpdate({ update_id: 3, message: message('محتوای پیام', 3) });
  assert.equal(s.session.draft.pending.length, 1);
  assert.equal(s.session.draft.name, 'نام جدید');
  await bot.handleUpdate({
    update_id: 4,
    message: {
      ...message('foreign', 4),
      from: { id: 999, is_bot: false, first_name: 'Other' },
    },
  });
  assert.equal(s.session.draft.pending.length, 1);
  assert.match(String(sent.at(-1)?.text), /خصوصی/);
  await bot.handleUpdate({ update_id: 5, message: message('/cancel', 5) });
  assert.equal(s.session.status, 'CANCELLED');
});
test('capture envelope omits unrelated forward metadata', () => {
  const raw = {
    ...textMessage(),
    forward_origin: {
      type: 'hidden_user',
      sender_user_name: 'Private',
      date: 1,
    },
  } as Message;
  assert.equal('forward_origin' in captureEnvelope(raw), false);
  assert.equal(captureEnvelope(raw).message_id, raw.message_id);
});
test('rule cap does not trap a draft in an unsaveable new form', async () => {
  const s = await setup();
  await toRules(s);
  await addDaily(s);
  const stored = s.repo.sessions.get('owner')!;
  stored.draft.rules = Array.from({ length: 20 }, () => ({
    id: randomUUID(),
    config: stored.draft.rules[0]!.config,
  }));
  await s.click('rule_add');
  assert.equal(s.session.step, 'RULE_LIST');
  assert.match(s.view!.text, /ابتدا/);
});
test('migrated target remains visibly selected and can be deselected', async () => {
  const s = await setup();
  await toRules(s);
  await addDaily(s);
  await s.click('targets');
  await s.click('target', '0');
  await s.targetRepo.migrate('owner', snapshot.chatId, {
    ...snapshot,
    chatId: '-2002',
    type: 'supergroup',
  });
  await s.click('page', '0');
  assert.equal(
    s.session.draft.targets[0]?.id,
    s.session.work.targetOptions[0]?.id,
  );
  await s.click('target', '0');
  assert.equal(s.session.draft.targets.length, 0);
});
test('restart restores form progress and timezone snapshot', async () => {
  const s = await setup();
  await toRules(s);
  await s.click('type', 'WEEKLY');
  await s.click('answer', '5');
  const id = s.session.id;
  s.repo.timezone = 'UTC';
  s.restart();
  await s.send({ type: 'start' });
  assert.equal(s.session.id, id);
  assert.equal(s.session.draft.timezone, 'Asia/Tehran');
  assert.deepEqual(s.session.work.builder?.weekdays, [5]);
  await s.click('answer', 'done');
  assert.match(s.view!.text, /هر چند هفته/);
});
test('content capture survives restart and preserves text/album/text order', async () => {
  const s = await setup();
  await s.send({ type: 'start' });
  await s.send({ type: 'text', text: 'آلبوم' });
  await s.send(incoming(textMessage(1)));
  await s.send(incoming(mediaMessage('video', 3, 'album')));
  await s.send(incoming(mediaMessage('photo', 2, 'album')));
  s.restart();
  await s.send({ type: 'start' });
  await s.click('content_done');
  assert.equal(s.session.step, 'CONTENT');
  assert.match(s.view!.text, /هنوز/);
  await s.send(incoming(textMessage(4)));
  s.time('2026-10-03T00:00:02Z');
  await s.click('content_done');
  assert.equal(s.session.step, 'RULE_TYPE');
  assert.deepEqual(
    s.session.draft.archives.map((a) => a.count),
    [1, 2, 1],
  );
  assert.deepEqual(
    s.calls.filter((c) => c.method.startsWith('copy')).map((c) => c.method),
    ['copyMessage', 'copyMessages', 'copyMessage'],
  );
});
test('failed archive keeps earlier content and requires explicit removal', async () => {
  const s = await setup();
  await s.send({ type: 'start' });
  await s.send({ type: 'text', text: 'test' });
  await s.send(incoming(textMessage(1)));
  await s.send(incoming(mediaMessage('photo', 2, 'incomplete')));
  s.time('2026-10-03T00:00:02Z');
  await s.click('content_done');
  assert.equal(s.session.step, 'CONTENT');
  assert.equal(s.session.draft.archives.length, 1);
  assert.equal(s.session.draft.pending[0]?.failed, true);
  await s.click('drop_failed');
  await s.click('content_done');
  assert.equal(s.session.step, 'RULE_TYPE');
});
test('stale and foreign session callbacks cannot transition state', async () => {
  const s = await setup();
  await toRules(s);
  const old = findButton(s.view, 'type', 'WEEKLY');
  await s.click('type', 'ONE_TIME');
  const rev = s.session.revision;
  await s.send({ type: 'callback', data: old });
  assert.equal(s.session.revision, rev);
  assert.match(s.view!.text, /قدیمی/);
  await s.send({
    type: 'callback',
    data: old.replace(s.session.token, 'AAAAAAAA'),
  });
  assert.equal(s.session.revision, rev);
});
test('duplicate Telegram update is a no-op and does not duplicate content', async () => {
  const s = await setup();
  await s.send({ type: 'start' });
  await s.send({ type: 'text', text: 'test' });
  const message = incoming(textMessage());
  await s.send(message);
  assert.equal(await s.replay(3, message), null);
  assert.equal(s.session.draft.pending.length, 1);
});
for (const step of steps)
  test(`/cancel deactivates draft in ${step}`, async () => {
    const s = await setup();
    await s.send({ type: 'start' });
    s.repo.sessions.get('owner')!.step = step;
    await s.send({ type: 'cancel' });
    assert.equal(s.session.status, 'CANCELLED');
    assert.equal(s.repo.commits, 0);
  });
test('expired session cannot accept old callback; new creates a fresh session', async () => {
  const s = await setup();
  await toRules(s);
  const id = s.session.id,
    old = findButton(s.view, 'type', 'WEEKLY');
  s.time('2026-10-05T00:00:00Z');
  await s.send({ type: 'callback', data: old });
  assert.equal(s.session.status, 'EXPIRED');
  await s.send({ type: 'start' });
  assert.notEqual(s.session.id, id);
  assert.equal(s.session.step, 'NAME');
});
test('callbacks stay under 64 UTF-8 bytes and forged target indexes do nothing', async () => {
  const s = await setup();
  await toRules(s);
  await addDaily(s);
  await s.click('targets');
  for (const button of s.view!.buttons.flat())
    assert.ok(Buffer.byteLength(button.data) <= 64);
  const forged = findButton(s.view, 'target', '0').replace(/:0$/, ':999');
  await s.send({ type: 'callback', data: forged });
  assert.equal(s.session.draft.targets.length, 0);
});
test('preview corrections retain other fields and expired one-time cannot confirm', async () => {
  const s = await setup();
  await toRules(s);
  await s.click('type', 'ONE_TIME');
  await s.send({ type: 'text', text: '2026-10-09' });
  await s.send({ type: 'text', text: '18:00' });
  await s.click('rule_save');
  await s.click('targets');
  await s.click('target', '0');
  await s.click('preview');
  await s.click('edit_name');
  await s.send({ type: 'text', text: 'نام تازه' });
  assert.equal(s.session.step, 'PREVIEW');
  assert.equal(s.session.draft.archives.length, 1);
  s.time('2026-10-09T18:00:00Z');
  // Keep the session alive to test rule expiry rather than session TTL.
  s.repo.sessions.get('owner')!.expiresAt = '2026-10-10T18:00:00Z';
  await s.click('confirm');
  assert.equal(s.repo.commits, 0);
  assert.match(s.view!.text, /قابل تأیید نیست/);
});
