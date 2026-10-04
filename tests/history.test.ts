import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBot } from '../src/infrastructure/telegram/bot.js';
import { Targets } from '../src/app/services/targets.js';
import { MemoryTargets, botInfo, snapshot } from './helpers/phase2.js';
import type { HistoryEntry } from '../src/app/delivery/history.js';
import type { Update } from 'grammy/types';
const reminder = '00000000-0000-4000-8000-000000000001';
test('Persian history is private, paginated and split safely, with reminder-filter callbacks', async () => {
  const reads: { owner: string; page: number; reminder: string | undefined }[] =
    [];
  const replies: {
    text: string;
    reply_markup?: { inline_keyboard: { callback_data: string }[][] };
  }[] = [];
  const entry: HistoryEntry = {
    id: 'execution',
    reminderId: reminder,
    name: 'یادآور فارسی',
    timezone: 'Asia/Tehran',
    scheduledFor: '2026-10-03T12:00:00Z',
    trigger: 'SCHEDULED',
    state: 'PARTIAL_FAILED',
    deliveries: Array.from({ length: 20 }, () => ({
      title: 'مقصد '.repeat(20),
      state: 'UNKNOWN',
      error: 'NETWORK_UNKNOWN',
      sent: 1,
      total: 3,
      nextAttempt: null,
    })),
  };
  const bot = createBot('123:test-token', '123', () => ({
    storageChatId: '-1001',
    targets: new Targets('db-owner', new MemoryTargets(), {
      inspect: async () => snapshot,
    }),
    history: {
      ownerId: 'db-owner',
      repository: {
        page: async (owner, page, filter) => {
          reads.push({ owner, page, reminder: filter });
          return { entries: [entry], hasNext: true };
        },
      },
    },
  }));
  bot.botInfo = botInfo;
  bot.api.config.use(async (_prev, method, payload) => {
    if (method === 'sendMessage') replies.push(payload as never);
    return {
      ok: true,
      result: method === 'sendMessage' ? { message_id: 1 } : true,
    } as never;
  });
  const command = (id: number): Update => ({
    update_id: id,
    message: {
      message_id: 1,
      date: 1,
      chat: { id, type: 'private', first_name: 'Owner' },
      from: { id, is_bot: false, first_name: 'Owner' },
      text: '/history',
      entities: [{ type: 'bot_command', offset: 0, length: 8 }],
    },
  });
  await bot.handleUpdate(command(999));
  assert.equal(reads.length, 0);
  assert.match(replies.at(-1)!.text, /خصوصی/);
  await bot.handleUpdate(command(123));
  assert.equal(reads[0]!.owner, 'db-owner');
  assert.ok(replies.every((r) => r.text.length < 4096));
  assert.ok(replies.some((r) => r.text.includes('نتیجه نامعلوم')));
  const buttons = replies.at(-1)!.reply_markup!.inline_keyboard.flat();
  assert.ok(buttons.some((b) => b.callback_data === `h:r:${reminder}:0`));
  assert.ok(buttons.every((b) => Buffer.byteLength(b.callback_data) <= 64));
  await bot.handleUpdate({
    update_id: 200,
    callback_query: {
      id: 'callback',
      from: { id: 123, is_bot: false, first_name: 'Owner' },
      chat_instance: 'private',
      data: `h:r:${reminder}:1`,
      message: {
        message_id: 1,
        date: 1,
        chat: { id: 123, type: 'private', first_name: 'Owner' },
        text: 'history',
      },
    },
  });
  assert.equal(reads.at(-1)!.reminder, reminder);
  assert.equal(reads.at(-1)!.page, 1);
});
