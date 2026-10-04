import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GrammyError } from 'grammy';
import {
  deliveryUnits,
  retryAt,
  type CanonicalContent,
  type DeliveryUnit,
} from '../src/app/delivery/model.js';
import {
  classifyDelivery,
  copyUnit,
  UncertainCopy,
} from '../src/infrastructure/telegram/delivery.js';
import { startDeliveryWorkers } from '../src/app/delivery/worker.js';
import { TargetUnavailable } from '../src/app/services/targets.js';
import { contentKinds } from '../src/domain/content/archive.js';
import { fakeApi } from './helpers/phase2.js';

const content = (
  id: number,
  album: string | null = null,
  archivePosition = 0,
): CanonicalContent => ({
  id: String(id),
  archiveId: album ?? String(id),
  archivePosition,
  storageChatId: '-1001',
  messageId: 100 + id,
  kind: album ? 'photo' : 'text',
  album,
});
const unit = (ids = [101]): DeliveryUnit => ({
  id: 'unit',
  sequence: 0,
  contentIds: ['content'],
  storageChatId: '-1001',
  messageIds: ids,
  kinds: ['photo'],
  state: 'PENDING',
  attempts: 0,
});
test('units preserve standalone/album/package order and repeated archive references', () => {
  const units = deliveryUnits([
    content(1),
    content(2, 'a', 0),
    content(3, 'a', 1),
    content(4),
    content(2, 'a', 0),
    content(3, 'a', 1),
  ]);
  assert.deepEqual(
    units.map((u) => u.messageIds),
    [[101], [102, 103], [104], [102, 103]],
  );
  assert.deepEqual(
    units.map((u) => u.sequence),
    [0, 1, 2, 3],
  );
  assert.throws(
    () => deliveryUnits([content(3, 'a', 0), content(2, 'a', 1)]),
    /order/,
  );
});
for (const kind of contentKinds)
  test(`canonical ${kind} is copied without transformation or uploading`, async () => {
    const { api, calls } = fakeApi();
    const u = unit();
    u.kinds = [kind];
    assert.deepEqual(await copyUnit(api, '-2001', u), [101]);
    assert.equal(calls[0]!.method, 'copyMessage');
    assert.deepEqual(calls[0]!.payload, {
      chat_id: '-2001',
      from_chat_id: '-1001',
      message_id: 101,
    });
  });
test('album uses one ordered copyMessages and rejects partial/duplicate results', async () => {
  const { api, calls } = fakeApi();
  assert.deepEqual(await copyUnit(api, '-2001', unit([101, 102])), [201, 202]);
  assert.equal(calls[0]!.method, 'copyMessages');
  for (const response of [
    [{ message_id: 1 }],
    [{ message_id: 1 }, { message_id: 1 }],
    [],
  ]) {
    const fake = fakeApi(() => response);
    await assert.rejects(
      copyUnit(fake.api, '-2001', unit([101, 102])),
      UncertainCopy,
    );
  }
});
function apiError(code: number, description = 'test', retry_after?: number) {
  return new GrammyError(
    'test',
    {
      ok: false,
      error_code: code,
      description,
      parameters: retry_after ? { retry_after } : {},
    },
    'copyMessage',
    {},
  );
}
test('classifies explicit errors separately from ambiguous sends and preflight transport failures', () => {
  assert.equal(
    classifyDelivery(apiError(429, 'rate', 60), true).retryAfter,
    60,
  );
  assert.equal(classifyDelivery(apiError(503), true).state, 'FAILED_RETRYABLE');
  assert.equal(classifyDelivery(apiError(403), true).targetUnavailable, true);
  assert.equal(
    classifyDelivery(apiError(400, 'chat not found'), true).targetUnavailable,
    true,
  );
  assert.equal(
    classifyDelivery(apiError(400, 'message not found'), true)
      .targetUnavailable,
    false,
  );
  assert.equal(
    classifyDelivery(new TargetUnavailable(), false).state,
    'FAILED_PERMANENT',
  );
  assert.equal(classifyDelivery(new Error('timeout'), true).state, 'UNKNOWN');
  assert.equal(
    classifyDelivery(new Error('timeout'), false).state,
    'FAILED_RETRYABLE',
  );
  assert.deepEqual(
    classifyDelivery(new UncertainCopy([5]), true).knownIds,
    [5],
  );
});
test('retry_after is a lower bound even above exponential cap; jitter and backoff bounded', () => {
  const now = '2026-10-03T12:00:00Z';
  assert.equal(
    retryAt(now, 1, 0, () => 0),
    '2026-10-03T12:00:01.000Z',
  );
  assert.equal(
    retryAt(now, 4, 0, () => 0),
    '2026-10-03T12:00:08.000Z',
  );
  assert.equal(
    retryAt(now, 100, 0, () => 0),
    '2026-10-03T12:05:00.000Z',
  );
  assert.equal(
    retryAt(now, 1, 600, () => 0.5),
    '2026-10-03T12:10:00.125Z',
  );
});
test('delivery loops bound concurrency and drain in-flight work on shutdown', async () => {
  let active = 0,
    peak = 0,
    release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const loops = startDeliveryWorkers(
    {
      runOne: async () => {
        active++;
        peak = Math.max(active, peak);
        await blocked;
        active--;
        return true;
      },
    },
    2,
    () => {},
  );
  const stopping = loops.stop();
  assert.equal(active, 2);
  release();
  await stopping;
  assert.equal(active, 0);
  assert.equal(peak, 2);
});
