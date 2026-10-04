import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Api } from 'grammy';
import {
  headerDay,
  headerSettingsSchema,
} from '../src/domain/daily-header/schedule.js';
import { formatDailyHeader } from '../src/ui/fa/daily-header.js';
import { TelegramHeaderTransport } from '../src/infrastructure/telegram/daily-header-transport.js';
import { loadConfig } from '../src/infrastructure/config/env.js';

test('daily header uses local date, latest day only and DST compatible boundaries', () => {
  const tehran = { timezone: 'Asia/Tehran', localTime: '00:10', pin: true };
  assert.deepEqual(headerDay('2026-10-03T20:45:00Z', tehran), {
    date: '2026-10-04',
    due: true,
    at: '2026-10-03T20:40:00Z',
    next: '2026-10-04T20:40:00Z',
  });
  assert.equal(headerDay('2026-10-03T20:35:00Z', tehran).due, false);
  const gap = { timezone: 'America/New_York', localTime: '02:30', pin: true };
  assert.equal(headerDay('2026-03-08T07:00:00Z', gap).due, false);
  assert.equal(headerDay('2026-03-08T07:30:00Z', gap).due, true);
  const overlap = headerDay('2026-11-01T06:30:00Z', {
    ...gap,
    localTime: '01:30',
  });
  assert.equal(overlap.at, '2026-11-01T05:30:00Z');
  assert.equal(overlap.next, '2026-11-02T06:30:00Z');
});
test('header settings reject invalid wall time/timezone; formatter explicitly uses Gregorian', () => {
  assert.equal(
    headerSettingsSchema.safeParse({
      timezone: 'UTC',
      localTime: '24:00',
      pin: false,
    }).success,
    false,
  );
  assert.match(formatDailyHeader('2026-10-03'), /۲۰۲۶/);
  assert.match(formatDailyHeader('2026-10-03'), /اکتبر/);
});
test('Telegram header sends text, silently pins and unpins exactly the supplied own message', async () => {
  const api = new Api('123:fake-token');
  const calls: { method: string; payload: unknown }[] = [];
  api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload });
    return {
      ok: true,
      result: method === 'sendMessage' ? { message_id: 555 } : true,
    } as never;
  });
  const transport = new TelegramHeaderTransport({} as never, api, () => 456);
  assert.equal(await transport.send('123', '2026-10-03'), 555);
  await transport.pin('123', 555);
  await transport.unpin('123', 444);
  assert.deepEqual(
    calls.map((c) => c.method),
    ['sendMessage', 'pinChatMessage', 'unpinChatMessage'],
  );
  assert.deepEqual(calls[1]!.payload, {
    chat_id: '123',
    message_id: 555,
    disable_notification: true,
  });
  assert.deepEqual(calls[2]!.payload, { chat_id: '123', message_id: 444 });
});
test('standard PORT configures the health server', () => {
  const env = {
    BOT_TOKEN: '123:fake',
    OWNER_TELEGRAM_USER_ID: '123',
    STORAGE_CHAT_ID: '-1001',
    DATABASE_URL: 'postgresql://localhost/remi',
    PORT: '8765',
  };
  assert.equal(loadConfig(env).PORT, 8765);
});
