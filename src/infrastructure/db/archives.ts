import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  Archive,
  ArchiveRepository,
  ArchivedItem,
} from '../../domain/content/archive.js';

interface ArchiveRow {
  id: string;
  owner_user_id: string;
  storage_chat_id: string;
  state: Archive['state'];
  error_code: string | null;
}
interface ItemRow {
  position: number;
  source_message_id: string;
  storage_message_id: string;
  content_type: ArchivedItem['kind'];
  telegram_file_id: string | null;
  telegram_file_unique_id: string | null;
  media_group_key: string | null;
  metadata: Record<string, unknown>;
}
async function read(db: Pool | PoolClient, row: ArchiveRow): Promise<Archive> {
  const result = await db.query<ItemRow>(
    'SELECT * FROM archived_content_items WHERE archive_id=$1 ORDER BY position',
    [row.id],
  );
  return {
    id: row.id,
    ownerId: row.owner_user_id,
    storageChatId: row.storage_chat_id,
    state: row.state,
    errorCode: row.error_code,
    items: result.rows.map((r) => ({
      position: r.position,
      sourceMessageId: Number(r.source_message_id),
      storageMessageId: Number(r.storage_message_id),
      kind: r.content_type,
      fileId: r.telegram_file_id,
      fileUniqueId: r.telegram_file_unique_id,
      mediaGroupKey: r.media_group_key,
      metadata: r.metadata,
    })),
  };
}
export class PgArchiveRepository implements ArchiveRepository {
  constructor(private readonly pool: Pool) {}
  async claim(
    ownerId: string,
    sourceKey: string,
    sourceChatId: string,
    storageChatId: string,
  ) {
    const inserted = await this.pool.query<ArchiveRow>(
      `INSERT INTO content_archives
      (id, owner_user_id, source_key, source_chat_id, storage_chat_id, state) VALUES ($1,$2,$3,$4,$5,'COPYING')
      ON CONFLICT(owner_user_id, source_key) DO NOTHING RETURNING *`,
      [randomUUID(), ownerId, sourceKey, sourceChatId, storageChatId],
    );
    const row =
      inserted.rows[0] ??
      (
        await this.pool.query<ArchiveRow>(
          'SELECT * FROM content_archives WHERE owner_user_id=$1 AND source_key=$2',
          [ownerId, sourceKey],
        )
      ).rows[0]!;
    return {
      acquired: inserted.rowCount === 1,
      archive: await read(this.pool, row),
    };
  }
  async complete(
    id: string,
    ownerId: string,
    items: readonly ArchivedItem[],
  ): Promise<Archive> {
    if (
      !items.length ||
      items.some(
        (item, index) =>
          item.position !== index ||
          !Number.isSafeInteger(item.storageMessageId) ||
          item.storageMessageId <= 0,
      )
    )
      throw new Error('Invalid archive items');
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const locked = await db.query<ArchiveRow>(
        "SELECT * FROM content_archives WHERE id=$1 AND owner_user_id=$2 AND state='COPYING' FOR UPDATE",
        [id, ownerId],
      );
      if (!locked.rows[0]) throw new Error('Archive is not writable');
      for (const item of items)
        await db.query(
          `INSERT INTO archived_content_items
        (archive_id,position,source_message_id,storage_message_id,content_type,telegram_file_id,telegram_file_unique_id,media_group_key,metadata)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            id,
            item.position,
            item.sourceMessageId,
            item.storageMessageId,
            item.kind,
            item.fileId,
            item.fileUniqueId,
            item.mediaGroupKey,
            JSON.stringify(item.metadata),
          ],
        );
      const result = await db.query<ArchiveRow>(
        "UPDATE content_archives SET state='READY', copied_message_ids=$2, updated_at=now() WHERE id=$1 RETURNING *",
        [id, JSON.stringify(items.map((i) => i.storageMessageId))],
      );
      const archive = await read(db, result.rows[0]!);
      await db.query('COMMIT');
      return archive;
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
    }
  }
  async fail(
    id: string,
    ownerId: string,
    state: 'REJECTED' | 'UNKNOWN',
    code: string,
    copiedIds: readonly number[],
  ) {
    await this.pool.query(
      "UPDATE content_archives SET state=$3,error_code=$4,copied_message_ids=$5,updated_at=now() WHERE id=$1 AND owner_user_id=$2 AND state='COPYING'",
      [id, ownerId, state, code, JSON.stringify(copiedIds)],
    );
  }
}
