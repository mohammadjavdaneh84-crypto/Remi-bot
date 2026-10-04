import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { loadConfig } from '../src/infrastructure/config/env.js';
import { createBot } from '../src/infrastructure/telegram/bot.js';
import { healthServer } from '../src/health/server.js';
import { startupFailure } from '../src/main.js';
import type { Update } from 'grammy/types';

const env = {
  BOT_TOKEN: '123:test-token',
  OWNER_TELEGRAM_USER_ID: '123',
  STORAGE_CHAT_ID: '-100123',
  DATABASE_URL: 'postgresql://test:test@localhost/remi',
};
test('configuration validates with defaults and preserves bigint IDs as strings', () => {
  const config = loadConfig({
    ...env,
    OWNER_TELEGRAM_USER_ID: '9007199254740993',
  });
  assert.equal(config.OWNER_TELEGRAM_USER_ID, '9007199254740993');
  assert.equal(config.DEFAULT_TIMEZONE, 'Asia/Tehran');
  assert.equal(config.MAX_CATCH_UP_EXECUTIONS_PER_RULE, 10);
});
test('startup diagnostics expose only a controlled cause and safe field/code names', () => {
  assert.deepEqual(
    startupFailure(
      new Error('Invalid environment fields: BOT_TOKEN, DATABASE_URL'),
    ),
    { cause: 'INVALID_CONFIG', fields: ['BOT_TOKEN', 'DATABASE_URL'] },
  );
  assert.deepEqual(startupFailure({ error_code: 401, token: 'secret' }), {
    cause: 'TELEGRAM_API_ERROR',
    telegram_error_code: 401,
  });
  assert.deepEqual(
    startupFailure({ code: 'ECONNREFUSED', password: 'secret' }),
    {
      cause: 'DATABASE_OR_NETWORK_ERROR',
      database_error_code: 'ECONNREFUSED',
    },
  );
  assert.deepEqual(startupFailure(new Error('raw private detail')), {
    cause: 'UNKNOWN_STARTUP_ERROR',
  });
});
for (const [key, value] of [
  ['BOT_TOKEN', 'secret'],
  ['DATABASE_URL', 'https://example.com'],
  ['OWNER_TELEGRAM_USER_ID', '-1'],
  ['STORAGE_CHAT_ID', '123'],
  ['DELIVERY_CONCURRENCY', '0'],
  ['DEFAULT_TIMEZONE', 'wrong'],
  ['PORT', '65536'],
  ['SCHEDULER_POLL_MS', '2147483648'],
  ['MAX_CATCH_UP_EXECUTIONS_PER_RULE', '1001'],
] as const) {
  test(`invalid environment ${key} rejected without leaking value`, () => {
    assert.throws(
      () => loadConfig({ ...env, [key]: value }),
      (error: Error) =>
        error.message.includes(key) && !error.message.includes('test-token'),
    );
  });
}
test('liveness, readiness and dependency failure have correct status', async () => {
  let state: 'ready' | 'not_ready' | 'error' = 'not_ready';
  const server = healthServer(async () => {
    if (state === 'error') throw new Error('DB unavailable');
    return state === 'ready';
  }, 'test-version');
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.deepEqual(await (await fetch(`${base}/version`)).json(), {
      version: 'test-version',
    });
    assert.equal((await fetch(`${base}/readyz`)).status, 503);
    state = 'ready';
    assert.equal((await fetch(`${base}/readyz`)).status, 200);
    state = 'error';
    assert.equal((await fetch(`${base}/readyz`)).status, 503);
    assert.equal((await fetch(`${base}/missing`)).status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function fakeBot() {
  const bot = createBot(env.BOT_TOKEN, env.OWNER_TELEGRAM_USER_ID);
  bot.botInfo = {
    id: 456,
    is_bot: true,
    first_name: 'REMI',
    username: 'remi_test_bot',
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    can_manage_bots: false,
    supports_join_request_queries: false,
  };
  const calls: { method: string; payload: unknown }[] = [];
  bot.api.config.use(async (_previous, method, payload) => {
    calls.push({ method, payload });
    return { ok: true, result: true } as never;
  });
  return { bot, calls };
}
function message(
  userId: number,
  chatType: 'private' | 'group' = 'private',
): Update {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 0,
      chat:
        chatType === 'private'
          ? { id: userId, type: 'private', first_name: 'Owner' }
          : { id: -123, type: 'group', title: 'Group' },
      from: { id: userId, is_bot: false, first_name: 'Owner' },
      text: '/start',
      entities: [{ type: 'bot_command', offset: 0, length: 6 }],
    },
  };
}
test('owner receives Persian start response through fake Bot API', async () => {
  const { bot, calls } = fakeBot();
  await bot.handleUpdate(message(123));
  assert.equal(calls.length, 1);
  assert.match(JSON.stringify(calls[0]?.payload), /به REMI خوش آمدید/);
});
test('unauthorized private user receives only private-bot notice', async () => {
  const { bot, calls } = fakeBot();
  await bot.handleUpdate(message(999));
  assert.equal(calls.length, 1);
  assert.match(JSON.stringify(calls[0]?.payload), /این ربات خصوصی است/);
});
test('owner commands in group ignored', async () => {
  const { bot, calls } = fakeBot();
  await bot.handleUpdate(message(123, 'group'));
  assert.equal(calls.length, 0);
});
test('unauthorized private callback is denied and acknowledged', async () => {
  const { bot, calls } = fakeBot();
  const msg = message(999).message!;
  await bot.handleUpdate({
    update_id: 2,
    callback_query: {
      id: 'callback',
      from: { id: 999, is_bot: false, first_name: 'Other' },
      chat_instance: 'instance',
      data: 'start',
      message: msg,
    },
  });
  assert.equal(calls[0]?.method, 'answerCallbackQuery');
});
