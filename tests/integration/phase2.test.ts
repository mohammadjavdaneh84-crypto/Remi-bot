import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PgTargetRepository } from '../../src/infrastructure/db/targets.js';
import { PgArchiveRepository } from '../../src/infrastructure/db/archives.js';
import { ContentCapture } from '../../src/infrastructure/telegram/storage/capture.js';
import { Targets } from '../../src/app/services/targets.js';
import { databaseUrl, withDatabase } from '../helpers/database.js';
import {
  fakeApi,
  mediaMessage,
  snapshot,
  textMessage,
} from '../helpers/phase2.js';

test(
  'targets: concurrent registration, removal persistence, owner isolation and DB constraints',
  { skip: !databaseUrl },
  async () => {
    await withDatabase(async (pool, owner, other) => {
      const repo = new PgTargetRepository(pool);
      const [a, b] = await Promise.all([
        repo.save(owner, snapshot),
        repo.save(owner, snapshot),
      ]);
      assert.equal(a.id, b.id);
      assert.equal((await repo.list(owner, 0, 20)).length, 1);
      const foreign = await repo.save(other, snapshot);
      assert.notEqual(a.id, foreign.id);
      assert.equal(await repo.byId(other, a.id), null);
      const removed = await repo.save(owner, {
        ...snapshot,
        reachable: false,
        membership: 'kicked',
      });
      assert.equal(removed.id, a.id);
      assert.equal(
        (await repo.byChat(owner, snapshot.chatId))?.reachable,
        false,
      );
      await assert.rejects(
        pool.query("UPDATE targets SET chat_type='private' WHERE id=$1", [
          a.id,
        ]),
      );
      await assert.rejects(
        pool.query('UPDATE targets SET telegram_chat_id=123 WHERE id=$1', [
          a.id,
        ]),
      );
    });
  },
);
test(
  'targets: migration with pre-discovered destination is atomic, repeatable and preserves old references',
  { skip: !databaseUrl },
  async () => {
    await withDatabase(async (pool, owner) => {
      const repo = new PgTargetRepository(pool);
      const old = await repo.save(owner, {
        ...snapshot,
        type: 'group',
        chatId: '-10',
      });
      const destination = { ...snapshot, type: 'supergroup' as const };
      const current = await repo.save(owner, destination);
      await Promise.all([
        repo.migrate(owner, '-10', destination),
        repo.migrate(owner, '-10', destination),
      ]);
      const targets = new Targets(owner, repo, {
        inspect: async () => destination,
      });
      assert.equal((await targets.resolve(old.id)).id, current.id);
      assert.equal((await repo.byId(owner, old.id))?.migratedToId, current.id);
      assert.equal((await repo.list(owner, 0, 20)).length, 1);
      await repo.save(owner, { ...snapshot, type: 'group', chatId: '-10' });
      assert.equal((await repo.byId(owner, old.id))?.reachable, false);
    });
  },
);
test(
  'archives: concurrent claim, ordered album persistence, fresh repository replay and immutable ready rows',
  { skip: !databaseUrl },
  async () => {
    await withDatabase(async (pool, owner, other) => {
      const repo = new PgArchiveRepository(pool);
      const claims = await Promise.all([
        repo.claim(owner, 'key', '123', '-1001'),
        repo.claim(owner, 'key', '123', '-1001'),
      ]);
      assert.equal(claims.filter((c) => c.acquired).length, 1);
      assert.equal(claims[0]!.archive.id, claims[1]!.archive.id);
      const item = {
        position: 0,
        sourceMessageId: 1,
        storageMessageId: 101,
        kind: 'photo' as const,
        fileId: 'photo-id',
        fileUniqueId: 'photo-unique',
        mediaGroupKey: 'album',
        metadata: { caption: 'متن' },
      };
      await assert.rejects(repo.complete(claims[0]!.archive.id, other, [item]));
      const ready = await repo.complete(claims[0]!.archive.id, owner, [
        item,
        { ...item, position: 1, sourceMessageId: 2, storageMessageId: 102 },
      ]);
      assert.deepEqual(
        ready.items.map((i) => i.storageMessageId),
        [101, 102],
      );
      const replay = await new PgArchiveRepository(pool).claim(
        owner,
        'key',
        '123',
        '-1001',
      );
      assert.equal(replay.acquired, false);
      assert.deepEqual(replay.archive, ready);
      await assert.rejects(repo.complete(ready.id, owner, [item]));
      await repo.fail(ready.id, owner, 'UNKNOWN', 'UNKNOWN', []);
      assert.equal(
        (await repo.claim(owner, 'key', '123', '-1001')).archive.state,
        'READY',
      );
      assert.notEqual(
        (await repo.claim(other, 'key', '999', '-1001')).archive.id,
        ready.id,
      );
    });
  },
);
test(
  'archives: failed item transaction rolls back and unknown intent cannot be reclaimed',
  { skip: !databaseUrl },
  async () => {
    await withDatabase(async (pool, owner) => {
      const repo = new PgArchiveRepository(pool);
      const { archive } = await repo.claim(owner, 'failure', '123', '-1001');
      const item = {
        position: 0,
        sourceMessageId: 1,
        storageMessageId: 101,
        kind: 'text' as const,
        fileId: null,
        fileUniqueId: null,
        mediaGroupKey: null,
        metadata: {},
      };
      await assert.rejects(
        repo.complete(archive.id, owner, [item, { ...item, position: 1 }]),
      );
      assert.equal(
        (
          await pool.query(
            'SELECT * FROM archived_content_items WHERE archive_id=$1',
            [archive.id],
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (await repo.claim(owner, 'failure', '123', '-1001')).archive.state,
        'COPYING',
      );
      await repo.fail(archive.id, owner, 'UNKNOWN', 'UNKNOWN', [101]);
      const replay = await repo.claim(owner, 'failure', '123', '-1001');
      assert.equal(replay.acquired, false);
      assert.equal(replay.archive.state, 'UNKNOWN');
    });
  },
);
test(
  'capture with real PostgreSQL commits independent ordered units and replays no Telegram copy',
  { skip: !databaseUrl },
  async () => {
    await withDatabase(async (pool, owner) => {
      const { api, calls } = fakeApi();
      const capture = new ContentCapture(
        api,
        new PgArchiveRepository(pool),
        owner,
        '123',
        '-1001',
        () => 456,
      );
      const units = [
        [textMessage()],
        [mediaMessage('photo', 3, 'a'), mediaMessage('video', 2, 'a')],
        [textMessage(4)],
      ];
      const archives = [];
      for (const unit of units) {
        const result = await capture.archiveUnit(unit);
        assert.ok(result.ok);
        archives.push(result.archive);
      }
      assert.deepEqual(
        archives.flatMap((a) => a.items.map((i) => i.sourceMessageId)),
        [1, 2, 3, 4],
      );
      const fresh = new ContentCapture(
        api,
        new PgArchiveRepository(pool),
        owner,
        '123',
        '-1001',
        () => 456,
      );
      for (const unit of units)
        assert.equal((await fresh.archiveUnit(unit)).ok, true);
      assert.equal(calls.filter((c) => c.method.startsWith('copy')).length, 3);
    });
  },
);
