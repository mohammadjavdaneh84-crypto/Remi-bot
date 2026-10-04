import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GrammyError } from 'grammy';
import type {
  Chat,
  ChatFullInfo,
  ChatMember,
  ChatMemberUpdated,
  Update,
} from 'grammy/types';
import { Targets, TargetUnavailable } from '../src/app/services/targets.js';
import {
  permissions,
  targetSnapshot,
} from '../src/infrastructure/telegram/permissions.js';
import {
  handleMembership,
  TelegramTargetInspector,
} from '../src/infrastructure/telegram/targets.js';
import { createBot } from '../src/infrastructure/telegram/bot.js';
import {
  admin,
  allSend,
  botInfo,
  chat,
  fakeApi,
  MemoryTargets,
  snapshot,
  textMessage,
} from './helpers/phase2.js';

function setup() {
  const repo = new MemoryTargets();
  const inspector = {
    inspect: async (chatId: string) => ({ ...snapshot, chatId }),
  };
  return { repo, inspector, targets: new Targets('owner', repo, inspector) };
}
const event = (
  member = admin,
  actor = 123,
  targetChat: Chat = chat,
): ChatMemberUpdated => ({
  chat: targetChat,
  date: 1,
  from: { id: actor, is_bot: false, first_name: 'Actor' },
  old_chat_member: { status: 'left', user: botInfo },
  new_chat_member: member,
});
test('ordinary group member can send allowed types without administrator role', () => {
  const group = {
    ...chat,
    type: 'supergroup',
    permissions: { can_send_messages: true, can_send_photos: true },
  } as ChatFullInfo;
  const rights = permissions(group, { user: botInfo, status: 'member' });
  assert.equal(rights.send.text, true);
  assert.equal(rights.send.photo, true);
  assert.equal(rights.send.video, false);
  assert.equal(rights.canPin, false);
});
test('restricted member rights and membership both required', () => {
  const group = { ...chat, type: 'supergroup' } as ChatFullInfo;
  const restricted = {
    user: botInfo,
    status: 'restricted',
    is_member: true,
    can_send_messages: true,
    can_send_photos: false,
  } as unknown as ChatMember;
  assert.equal(permissions(group, restricted).send.text, true);
  assert.equal(
    permissions(group, { ...restricted, is_member: false } as ChatMember).send
      .text,
    false,
  );
});
for (const status of ['left', 'kicked'] as const)
  test(`${status} loses all permissions`, () => {
    const member = { status, user: botInfo, until_date: 0 } as ChatMember;
    assert.equal(
      Object.values(permissions(chat, member).send).some(Boolean),
      false,
    );
    assert.equal(targetSnapshot(chat, member).reachable, false);
  });
test('channel posting and pin permissions independent', () => {
  const rights = permissions(chat, {
    ...admin,
    can_post_messages: true,
    can_edit_messages: false,
  } as ChatMember);
  assert.equal(rights.send.video, true);
  assert.equal(rights.canPin, false);
  assert.equal(
    permissions(chat, { ...admin, can_post_messages: false } as ChatMember).send
      .text,
    false,
  );
});
test('private targets rejected', () =>
  assert.throws(() => targetSnapshot(textMessage().chat, admin)));
test('discovery requires owner action; storage and private chats excluded', async () => {
  const { targets, repo } = setup();
  const { api } = fakeApi();
  await handleMembership(event(admin, 999), targets, api, '123', '-999');
  assert.equal(repo.entries.size, 0);
  await handleMembership(event(), targets, api, '123', '-1001');
  await handleMembership(
    event(admin, 123, textMessage().chat),
    targets,
    api,
    '123',
    '-999',
  );
  assert.equal(repo.entries.size, 0);
  await handleMembership(event(), targets, api, '123', '-999');
  await handleMembership(event(), targets, api, '123', '-999');
  assert.equal(repo.entries.size, 1);
});
test('removal by other administrator persists inactive target without querying inaccessible chat', async () => {
  const { targets, repo } = setup();
  await targets.discover(snapshot, true);
  const { api, calls } = fakeApi(() => {
    throw new Error('should not call');
  });
  await handleMembership(
    event({ status: 'kicked', until_date: 0, user: botInfo }, 999),
    targets,
    api,
    '123',
    '-999',
  );
  assert.equal(repo.entries.size, 1);
  assert.equal([...repo.entries.values()][0]?.reachable, false);
  assert.equal(calls.length, 0);
});
test('temporary membership lookup failure does not downgrade stored permissions', async () => {
  const { targets, repo } = setup();
  await targets.discover(snapshot, true);
  const { api } = fakeApi(() => {
    throw new Error('timeout');
  });
  await assert.rejects(handleMembership(event(), targets, api, '123', '-999'));
  assert.equal([...repo.entries.values()][0]?.permissions.send.video, true);
});
test('initial owner discovery survives lookup outage with conservative group permissions', async () => {
  const { targets, repo } = setup();
  const { api } = fakeApi(() => {
    throw new Error('network');
  });
  await handleMembership(
    event({ status: 'member', user: botInfo }, 123, {
      id: -10,
      type: 'group',
      title: 'Group',
    }),
    targets,
    api,
    '123',
    '-999',
  );
  assert.equal(repo.entries.size, 1);
  assert.equal([...repo.entries.values()][0]?.permissions.send.text, false);
});
test('target revalidation is scoped to owner and checks content-specific rights', async () => {
  const { targets, repo, inspector } = setup();
  const foreign = await repo.save('other-owner', snapshot);
  await assert.rejects(targets.revalidate(foreign.id));
  const owned = await repo.save('owner', snapshot);
  inspector.inspect = async () => ({
    ...snapshot,
    permissions: { send: { ...allSend, video: false }, canPin: false },
  });
  await assert.rejects(targets.revalidate(owned.id, ['video']));
  assert.equal(
    (await targets.revalidate(owned.id, ['text'])).permissions.send.text,
    true,
  );
});
test('permanent access failure marks unreachable; transient errors preserve state', async () => {
  const { targets, repo, inspector } = setup();
  const row = await repo.save('owner', snapshot);
  inspector.inspect = async () => {
    throw new Error('network');
  };
  await assert.rejects(targets.revalidate(row.id));
  assert.equal((await targets.resolve(row.id)).reachable, true);
  inspector.inspect = async () => {
    throw new TargetUnavailable();
  };
  await assert.rejects(targets.revalidate(row.id));
  assert.equal((await targets.resolve(row.id)).reachable, false);
});
test('Telegram inspector uses getChatMember and classifies forbidden', async () => {
  const { api, calls } = fakeApi();
  const inspector = new TelegramTargetInspector(api, () => 456);
  assert.equal((await inspector.inspect('-1001')).permissions.send.video, true);
  assert.deepEqual(calls[1]?.payload, { chat_id: '-1001', user_id: 456 });
  const forbidden = fakeApi((method) => {
    throw new GrammyError(
      'failed',
      { ok: false, error_code: 403, description: 'Forbidden' },
      method,
      {},
    );
  });
  await assert.rejects(
    new TelegramTargetInspector(forbidden.api, () => 456).inspect('-1001'),
    TargetUnavailable,
  );
});
test('migration retains old identity as redirect and ignores late old-chat events', async () => {
  const { targets, repo, inspector } = setup();
  const old = await repo.save('owner', {
    ...snapshot,
    chatId: '-10',
    type: 'group',
  });
  inspector.inspect = async (chatId) => ({
    ...snapshot,
    type: 'supergroup',
    chatId,
  });
  await targets.migrate('-10', '-1001');
  await targets.migrate('-10', '-1001');
  await targets.discover({ ...snapshot, chatId: '-10', type: 'group' }, true);
  assert.equal(repo.entries.size, 2);
  assert.equal((await targets.list()).length, 1);
  assert.equal((await targets.resolve(old.id)).chatId, '-1001');
});
test('migration records new identity during outage, but marks it unavailable', async () => {
  const { targets, repo, inspector } = setup();
  const old = await repo.save('owner', {
    ...snapshot,
    chatId: '-10',
    type: 'group',
  });
  inspector.inspect = async () => {
    throw new Error('outage');
  };
  await targets.migrate('-10', '-1001');
  assert.equal((await targets.resolve(old.id)).chatId, '-1001');
  assert.equal((await targets.resolve(old.id)).reachable, false);
});
test('target pagination bounds and owner scoping', async () => {
  const { targets, repo } = setup();
  for (let i = 0; i < 12; i++)
    await repo.save('owner', { ...snapshot, chatId: String(-100 - i) });
  await repo.save('other', snapshot);
  assert.equal((await targets.list(0)).length, 11);
  assert.equal((await targets.list(1)).length, 2);
  assert.throws(() => targets.list(-1));
});
test('wired bot processes membership before private gate and restricts targets command', async () => {
  const { targets, repo } = setup();
  const bot = createBot('123:test-token', '123', () => ({
    targets,
    storageChatId: '-999',
  }));
  bot.botInfo = botInfo;
  const methods: string[] = [];
  bot.api.config.use(async (_prev, method) => {
    methods.push(method);
    return { ok: true, result: method === 'getChat' ? chat : true } as never;
  });
  await bot.handleUpdate({ update_id: 1, my_chat_member: event() });
  assert.equal(repo.entries.size, 1);
  const command = {
    ...textMessage(),
    text: '/targets',
    entities: [{ type: 'bot_command', offset: 0, length: 8 }],
  } as MessageForUpdate;
  await bot.handleUpdate({ update_id: 2, message: command });
  assert.ok(methods.includes('sendMessage'));
  const count = methods.length;
  await bot.handleUpdate({
    update_id: 3,
    message: { ...command, chat: { id: -10, type: 'group', title: 'Group' } },
  });
  assert.equal(methods.length, count);
});
type MessageForUpdate = NonNullable<Update['message']>;
