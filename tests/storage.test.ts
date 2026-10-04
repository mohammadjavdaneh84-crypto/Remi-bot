import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GrammyError } from 'grammy';
import type { Message } from 'grammy/types';
import { contentKinds } from '../src/domain/content/archive.js';
import {
  ContentCapture,
  captureItem,
} from '../src/infrastructure/telegram/storage/capture.js';
import { verifyStorage } from '../src/infrastructure/telegram/storage/verify.js';
import {
  fakeApi,
  MemoryArchives,
  textMessage,
  mediaMessage,
  chat,
  admin,
} from './helpers/phase2.js';

function setup(api = fakeApi(), repo = new MemoryArchives()) {
  return {
    ...api,
    repo,
    capture: new ContentCapture(
      api.api,
      repo,
      'owner',
      '123',
      '-1001',
      () => 456,
    ),
  };
}
for (const kind of contentKinds)
  test(`capture ${kind} keeps Telegram refs only`, async () => {
    const { capture, calls } = setup();
    const message = kind === 'text' ? textMessage() : mediaMessage(kind);
    const result = await capture.archiveUnit([message]);
    assert.ok(result.ok);
    assert.equal(result.archive.items[0]?.kind, kind);
    assert.equal(result.archive.items[0]?.storageMessageId, 101);
    assert.equal(
      result.archive.items[0]?.fileId,
      kind === 'text' ? null : `${kind}-id`,
    );
    assert.deepEqual(
      calls.map((c) => c.method),
      ['getChat', 'getChatMember', 'copyMessage'],
    );
  });
test('animation beats Telegram document fallback', () => {
  assert.equal(
    captureItem({
      ...mediaMessage('animation'),
      document: { file_id: 'doc', file_unique_id: 'doc' },
    } as Message)?.kind,
    'animation',
  );
});
test('album copies once in increasing source order and preserves grouping', async () => {
  const { capture, calls } = setup();
  const result = await capture.archiveUnit([
    mediaMessage('video', 2, 'album'),
    mediaMessage('photo', 1, 'album'),
  ]);
  assert.ok(result.ok);
  assert.deepEqual(
    result.archive.items.map((i) => [
      i.position,
      i.storageMessageId,
      i.mediaGroupKey,
    ]),
    [
      [0, 101, 'album'],
      [1, 102, 'album'],
    ],
  );
  assert.deepEqual(
    calls.find((c) => c.method === 'copyMessages')?.payload.message_ids,
    [1, 2],
  );
});
test('captions/entities persist without changing original input or canonical message', async () => {
  const { capture, calls } = setup();
  const message = {
    ...mediaMessage('photo'),
    caption: 'متن',
    caption_entities: [{ type: 'bold', offset: 0, length: 3 }],
  } as Message;
  const before = JSON.stringify(message);
  const result = await capture.archiveUnit([message]);
  assert.ok(result.ok);
  assert.equal(result.archive.items[0]?.metadata.caption, 'متن');
  assert.equal(JSON.stringify(message), before);
  assert.equal(
    calls.some((c) => c.method.startsWith('edit')),
    false,
  );
});
test('duplicate/concurrent source does not copy twice', async () => {
  const { capture, calls } = setup();
  const results = await Promise.all([
    capture.archiveUnit([textMessage()]),
    capture.archiveUnit([textMessage()]),
  ]);
  assert.ok(results.some((r) => r.ok));
  const replay = await capture.archiveUnit([textMessage()]);
  assert.ok(replay.ok);
  assert.equal(calls.filter((c) => c.method === 'copyMessage').length, 1);
});
test('edited source creates new immutable archive', async () => {
  const { capture, calls } = setup();
  const first = await capture.archiveUnit([textMessage()]);
  const second = await capture.archiveUnit([
    { ...textMessage(), text: 'edited', edit_date: 10 } as Message,
  ]);
  assert.ok(first.ok && second.ok);
  assert.notEqual(first.archive.id, second.archive.id);
  assert.equal(first.archive.items[0]?.metadata.text, 'text 1');
  assert.equal(calls.filter((c) => c.method === 'copyMessage').length, 2);
});
for (const unit of [
  [],
  [mediaMessage('photo', 1, 'a')],
  [textMessage(1), textMessage(2)],
  [mediaMessage('photo', 1, 'a'), mediaMessage('video', 2, 'b')],
  [mediaMessage('audio', 1, 'a'), mediaMessage('photo', 2, 'a')],
  [mediaMessage('photo', 1, 'a'), mediaMessage('photo', 1, 'a')],
]) {
  test(`invalid content unit rejected before API: ${unit.length} items ${unit[0]?.message_id ?? 0}`, async () => {
    const { capture, calls } = setup();
    const result = await capture.archiveUnit(unit);
    assert.equal(result.ok, false);
    assert.equal(calls.length, 0);
  });
}
test('unsupported, protected and foreign messages leave existing content intact', async () => {
  const { capture, calls, repo } = setup();
  await capture.archiveUnit([textMessage()]);
  const before = calls.length;
  const service = {
    message_id: 2,
    date: 1,
    chat: textMessage().chat,
    from: textMessage().from,
    new_chat_title: 'service',
  } as Message;
  for (const message of [
    service,
    { ...textMessage(), has_protected_content: true as const },
    {
      ...textMessage(),
      from: { id: 999, is_bot: false, first_name: 'Other' },
    } as Message,
  ]) {
    assert.equal((await capture.archiveUnit([message])).ok, false);
  }
  assert.equal(calls.length, before);
  assert.equal(repo.entries.size, 1);
});
test('partial album response never creates an incorrect mapping or retries', async () => {
  const api = fakeApi((method) =>
    method === 'getChat'
      ? chat
      : method === 'getChatMember'
        ? admin
        : [{ message_id: 101 }],
  );
  const { capture, repo, calls } = setup(api);
  const unit = [mediaMessage('photo', 1, 'a'), mediaMessage('photo', 2, 'a')];
  assert.deepEqual((await capture.archiveUnit(unit)).ok, false);
  assert.equal([...repo.entries.values()][0]?.state, 'UNKNOWN');
  assert.equal([...repo.entries.values()][0]?.items.length, 0);
  await capture.archiveUnit(unit);
  assert.equal(calls.filter((c) => c.method === 'copyMessages').length, 1);
});
for (const status of [400, 403, 429, 500, 0])
  test(`copy failure ${status} is safe and does not auto resend`, async () => {
    const api = fakeApi((method) => {
      if (method === 'getChat') return chat;
      if (method === 'getChatMember') return admin;
      if (!status) throw new Error('timeout with sensitive request');
      throw new GrammyError(
        'failed',
        {
          ok: false,
          error_code: status,
          description: 'failure',
          parameters: { retry_after: 10 },
        },
        method,
        {},
      );
    });
    const { capture, repo, calls } = setup(api);
    const result = await capture.archiveUnit([textMessage()]);
    assert.ok(!result.ok);
    assert.equal(
      result.code,
      status === 429
        ? 'TEMPORARY'
        : status === 400 || status === 403
          ? 'COPY_REJECTED'
          : 'UNKNOWN',
    );
    assert.doesNotMatch(result.message, /sensitive/);
    await capture.archiveUnit([textMessage()]);
    assert.equal(calls.filter((c) => c.method === 'copyMessage').length, 1);
    assert.equal([...repo.entries.values()][0]?.items.length, 0);
  });
test('DB failure after copy leaves non-replayable intent', async () => {
  const repo = new MemoryArchives();
  repo.complete = async () => {
    throw new Error('db down');
  };
  repo.fail = async () => {
    throw new Error('db down');
  };
  const { capture, calls } = setup(fakeApi(), repo);
  assert.equal((await capture.archiveUnit([textMessage()])).ok, false);
  assert.equal([...repo.entries.values()][0]?.state, 'COPYING');
  await capture.archiveUnit([textMessage()]);
  assert.equal(calls.filter((c) => c.method === 'copyMessage').length, 1);
});
test('DB claim failure returns a friendly error without starting a Telegram copy', async () => {
  const repo = new MemoryArchives();
  repo.claim = async () => {
    throw new Error('sensitive DB connection');
  };
  const { capture, calls } = setup(fakeApi(), repo);
  const result = await capture.archiveUnit([textMessage()]);
  assert.ok(!result.ok);
  assert.equal(result.code, 'TEMPORARY');
  assert.doesNotMatch(result.message, /sensitive/);
  assert.equal(
    calls.some((call) => call.method.startsWith('copy')),
    false,
  );
});
for (const bad of [
  { ...chat, username: 'public' },
  { ...chat, active_usernames: ['public'] },
  { ...chat, has_protected_content: true },
  { ...chat, type: 'group' },
  { ...chat, type: 'private' },
]) {
  test(`storage rejects unsafe location ${JSON.stringify(bad)}`, async () => {
    const { api } = fakeApi((method) => (method === 'getChat' ? bad : admin));
    await assert.rejects(verifyStorage(api, '-1001', 456, ['text']));
  });
}
test('channel without posting and group without media rights fail storage verification', async () => {
  const noPost = fakeApi((method) =>
    method === 'getChat' ? chat : { ...admin, can_post_messages: false },
  );
  await assert.rejects(verifyStorage(noPost.api, '-1001', 456, ['text']));
  const group = fakeApi((method) =>
    method === 'getChat'
      ? {
          ...chat,
          type: 'supergroup',
          permissions: { can_send_messages: true },
        }
      : { status: 'member', user: admin.user },
  );
  await verifyStorage(group.api, '-1001', 456, ['text']);
  await assert.rejects(verifyStorage(group.api, '-1001', 456, ['video']));
});
