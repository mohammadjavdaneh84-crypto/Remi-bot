import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  Target,
  TargetRepository,
  TargetSnapshot,
  Permissions,
} from '../../domain/target/target.js';

interface Row {
  id: string;
  owner_user_id: string;
  telegram_chat_id: string;
  chat_type: Target['type'];
  title: string;
  username: string | null;
  membership_status: string;
  permissions: Permissions;
  is_reachable: boolean;
  migrated_to_id: string | null;
}
function map(row: Row): Target {
  return {
    id: row.id,
    ownerId: row.owner_user_id,
    chatId: row.telegram_chat_id,
    type: row.chat_type,
    title: row.title,
    username: row.username,
    membership: row.membership_status,
    permissions: row.permissions,
    reachable: row.is_reachable,
    migratedToId: row.migrated_to_id,
  };
}
async function upsert(
  db: Pool | PoolClient,
  ownerId: string,
  s: TargetSnapshot,
): Promise<Target> {
  const result = await db.query<Row>(
    `INSERT INTO targets
    (id, owner_user_id, telegram_chat_id, chat_type, title, username, membership_status, permissions, is_reachable)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT(owner_user_id, telegram_chat_id) DO UPDATE SET
      chat_type=EXCLUDED.chat_type, title=EXCLUDED.title, username=EXCLUDED.username,
      membership_status=EXCLUDED.membership_status, permissions=EXCLUDED.permissions,
      is_reachable=EXCLUDED.is_reachable, last_checked_at=now(), updated_at=now()
    WHERE targets.migrated_to_id IS NULL RETURNING *`,
    [
      randomUUID(),
      ownerId,
      s.chatId,
      s.type,
      s.title,
      s.username,
      s.membership,
      JSON.stringify(s.permissions),
      s.reachable,
    ],
  );
  if (result.rows[0]) return map(result.rows[0]);
  const existing = await db.query<Row>(
    'SELECT * FROM targets WHERE owner_user_id=$1 AND telegram_chat_id=$2',
    [ownerId, s.chatId],
  );
  return map(existing.rows[0]!);
}
export class PgTargetRepository implements TargetRepository {
  constructor(private readonly pool: Pool) {}
  async byChat(ownerId: string, chatId: string) {
    const result = await this.pool.query<Row>(
      'SELECT * FROM targets WHERE owner_user_id=$1 AND telegram_chat_id=$2',
      [ownerId, chatId],
    );
    return result.rows[0] ? map(result.rows[0]) : null;
  }
  async byId(ownerId: string, id: string) {
    const result = await this.pool.query<Row>(
      'SELECT * FROM targets WHERE owner_user_id=$1 AND id=$2',
      [ownerId, id],
    );
    return result.rows[0] ? map(result.rows[0]) : null;
  }
  save(ownerId: string, snapshot: TargetSnapshot) {
    return upsert(this.pool, ownerId, snapshot);
  }
  async list(ownerId: string, offset: number, limit: number) {
    const result = await this.pool.query<Row>(
      'SELECT * FROM targets WHERE owner_user_id=$1 AND migrated_to_id IS NULL ORDER BY discovered_at, id OFFSET $2 LIMIT $3',
      [ownerId, offset, limit],
    );
    return result.rows.map(map);
  }
  async migrate(
    ownerId: string,
    oldChatId: string,
    destination: TargetSnapshot,
  ) {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      // Serialize migrations for this owner; retain old rows as history-safe redirects.
      await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [ownerId]);
      const old = await db.query<Row>(
        'SELECT * FROM targets WHERE owner_user_id=$1 AND telegram_chat_id=$2 FOR UPDATE',
        [ownerId, oldChatId],
      );
      if (
        old.rows[0] &&
        !old.rows[0].migrated_to_id &&
        oldChatId !== destination.chatId
      ) {
        const current = await upsert(db, ownerId, destination);
        if (current.migratedToId)
          throw new Error('Invalid migration destination');
        await db.query(
          'UPDATE targets SET migrated_to_id=$1, is_reachable=false, updated_at=now() WHERE id=$2',
          [current.id, old.rows[0].id],
        );
      }
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
    }
  }
}
