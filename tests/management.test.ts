import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBot } from '../src/infrastructure/telegram/bot.js';
import { CreationWizard } from '../src/app/wizard/service.js';
import { Targets } from '../src/app/services/targets.js';
import { MemoryWizardRepository } from './helpers/wizard.js';
import { MemoryTargets, botInfo, snapshot } from './helpers/phase2.js';
import type {
  ManagementAction,
  ReminderSummary,
} from '../src/app/management/model.js';
import type { Update } from 'grammy/types';
const id = '00000000-0000-4000-8000-000000000001';
test('management UI requires confirmation for run/delete, denies other owners and previews only privately', async () => {
  const r: ReminderSummary = {
    id,
    name: 'یادآور',
    status: 'PAUSED',
    revision: 0,
    timezone: 'UTC',
    nextDue: null,
    rules: 1,
    targets: 1,
  };
  const acts: ManagementAction[] = [],
    copies: string[] = [],
    replies: {
      text: string;
      reply_markup?: { inline_keyboard: { callback_data: string }[][] };
    }[] = [];
  const targets = new Targets('owner', new MemoryTargets(), {
    inspect: async () => snapshot,
  });
  const wizard = new CreationWizard(
    'owner',
    new MemoryWizardRepository(),
    targets,
    { archive: async () => ({ ok: false, message: 'unused' }) },
  );
  const bot = createBot('123:test-token', '123', () => ({
    storageChatId: '-1001',
    targets,
    wizard,
    management: {
      ownerId: 'owner',
      repository: {
        list: async () => ({ rows: [r], hasNext: false }),
        get: async () => r,
        act: async (_o, _id, _rev, a) => {
          acts.push(a);
          return id;
        },
        content: async () => [
          {
            id: 'content',
            archiveId: 'archive',
            archivePosition: 0,
            storageChatId: '-1001',
            messageId: 101,
            kind: 'text',
            album: null,
          },
        ],
      },
    },
  }));
  bot.botInfo = botInfo;
  bot.api.config.use(async (_prev, method, payload) => {
    if (method === 'sendMessage') replies.push(payload as never);
    if (method === 'copyMessage')
      copies.push(String((payload as { chat_id: string }).chat_id));
    return {
      ok: true,
      result: method === 'answerCallbackQuery' ? true : { message_id: 1 },
    } as never;
  });
  let seq = 0;
  const click = (data: string, owner = 123) =>
    bot.handleUpdate({
      update_id: ++seq,
      callback_query: {
        id: String(seq),
        from: { id: owner, is_bot: false, first_name: 'Owner' },
        chat_instance: 'private',
        data,
        message: {
          message_id: 1,
          date: 1,
          chat: { id: owner, type: 'private', first_name: 'Owner' },
          text: 'menu',
        },
      },
    } as Update);
  await click(`m:run:${id}:0`, 999);
  assert.equal(acts.length, 0);
  await click(`m:askrun:${id}:0`);
  assert.equal(acts.length, 0);
  assert.match(replies.at(-1)!.text, /همین الآن/);
  const run = replies
    .at(-1)!
    .reply_markup!.inline_keyboard.flat()
    .find((b) => b.callback_data.startsWith('m:run:'))!;
  await click(run.callback_data);
  assert.deepEqual(acts, ['run']);
  await click(`m:askdelete:${id}:0`);
  assert.deepEqual(acts, ['run']);
  assert.match(replies.at(-1)!.text, /حذف شود/);
  await click(`m:show:${id}`);
  assert.ok(
    replies
      .at(-1)!
      .reply_markup!.inline_keyboard.flat()
      .every((b) => Buffer.byteLength(b.callback_data) <= 64),
  );
  await click(`m:preview:${id}:0`);
  assert.deepEqual(copies, ['123']);
  r.revision = 1;
  await click(`m:delete:${id}:0`);
  assert.ok(!acts.includes('delete'));
  assert.match(replies.at(-1)!.text, /قدیمی/);
});
