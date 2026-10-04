import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  headerDay,
  headerSettingsSchema,
} from '../../domain/daily-header/schedule.js';
import {
  HeaderConflict,
  type HeaderConfig,
  type HeaderSession,
} from '../../app/daily-header/model.js';

export const headerColumns = `id,owner_user_id AS "ownerId",target_id AS "targetId",telegram_chat_id AS "chatId",title,
timezone,local_time AS "localTime",pin_enabled AS pin,enabled,revision,next_due_at AS "nextDue"`;
export async function headerTransaction<T>(
  pool: Pool,
  run: (db: PoolClient) => Promise<T>,
) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const result = await run(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}
export async function lockHeader(db: PoolClient, id: string) {
  const r = await db.query<{ locked: boolean }>(
    'SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked',
    ['header:' + id],
  );
  if (!r.rows[0]!.locked) throw new HeaderConflict();
}
export class PgDailyHeaders {
  constructor(private readonly pool: Pool) {}
  async list(owner: string, page = 0) {
    const rows = await this.pool.query<HeaderConfig>(
      `SELECT ${headerColumns} FROM daily_header_configs WHERE owner_user_id=$1 ORDER BY created_at,id LIMIT 11 OFFSET $2`,
      [owner, page * 10],
    );
    return rows.rows;
  }
  async get(owner: string, id: string) {
    return (
      (
        await this.pool.query<HeaderConfig>(
          `SELECT ${headerColumns} FROM daily_header_configs WHERE owner_user_id=$1 AND id=$2`,
          [owner, id],
        )
      ).rows[0] ?? null
    );
  }
  async history(owner: string, id: string) {
    return (
      await this.pool.query<{
        date: string;
        state: string;
        stage: string;
        code: string | null;
      }>(
        `SELECT r.local_date::text AS date,r.state,r.stage,r.last_error_code AS code FROM daily_header_runs r JOIN daily_header_configs c ON c.id=r.config_id WHERE c.owner_user_id=$1 AND c.id=$2 ORDER BY r.local_date DESC LIMIT 5`,
        [owner, id],
      )
    ).rows;
  }
  async draft(owner: string, now: string): Promise<HeaderSession | null> {
    return (
      (
        await this.pool.query<HeaderSession>(
          'SELECT token,revision,payload FROM daily_header_drafts WHERE owner_user_id=$1 AND expires_at>$2',
          [owner, now],
        )
      ).rows[0] ?? null
    );
  }
  async begin(
    owner: string,
    now: string,
    id?: string,
    revision?: number,
  ): Promise<HeaderSession> {
    return headerTransaction(this.pool, async (db) => {
      const user = (
        await db.query<{ telegram_user_id: string; default_timezone: string }>(
          'SELECT telegram_user_id,default_timezone FROM users WHERE id=$1 FOR NO KEY UPDATE',
          [owner],
        )
      ).rows[0]!;
      if (
        (
          await db.query(
            "SELECT id FROM wizard_sessions WHERE owner_user_id=$1 AND status='ACTIVE' AND expires_at>$2",
            [owner, now],
          )
        ).rowCount
      )
        throw new HeaderConflict(
          'ابتدا پیش‌نویس یادآور را با /new ادامه دهید یا با /cancel لغو کنید.',
        );
      const current = await this.draft(owner, now);
      if (current) return current;
      const config = id ? await this.get(owner, id) : null;
      if (id && (!config || config.revision !== revision))
        throw new HeaderConflict();
      const session: HeaderSession = {
        token: randomUUID(),
        revision: 0,
        payload: {
          step: config ? 'TIME' : 'TARGET',
          configId: config?.id ?? null,
          baseRevision: config?.revision ?? null,
          targetId: config?.targetId ?? null,
          chatId: config?.chatId ?? user.telegram_user_id,
          title: config?.title ?? 'پیوی من',
          timezone: config?.timezone ?? user.default_timezone,
          localTime: config?.localTime ?? '08:00',
          pin: config?.pin ?? true,
        },
      };
      await db.query(
        `INSERT INTO daily_header_drafts(owner_user_id,token,revision,payload,expires_at) VALUES($1,$2,0,$3,$4::timestamptz+interval '24 hours') ON CONFLICT(owner_user_id) DO UPDATE SET token=EXCLUDED.token,revision=0,payload=EXCLUDED.payload,expires_at=EXCLUDED.expires_at`,
        [owner, session.token, session.payload, now],
      );
      return session;
    });
  }
  async change(
    owner: string,
    update: number,
    session: HeaderSession,
    now: string,
    save = false,
  ): Promise<void> {
    await headerTransaction(this.pool, async (db) => {
      await db.query('SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE', [
        owner,
      ]);
      const seen = await db.query(
        'INSERT INTO daily_header_updates(owner_user_id,update_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING update_id',
        [owner, update],
      );
      if (!seen.rowCount) return;
      const current = await db.query(
        'SELECT token FROM daily_header_drafts WHERE owner_user_id=$1 AND token=$2 AND revision=$3 AND expires_at>$4 FOR UPDATE',
        [owner, session.token, session.revision, now],
      );
      if (!current.rowCount) throw new HeaderConflict();
      if (!save) {
        await db.query(
          'UPDATE daily_header_drafts SET payload=$2,revision=revision+1 WHERE owner_user_id=$1',
          [owner, session.payload],
        );
        return;
      }
      const p = session.payload;
      headerSettingsSchema.parse(p);
      if (p.step !== 'CONFIRM') throw new HeaderConflict();
      if (p.targetId) {
        if (
          !(
            await db.query(
              'SELECT id FROM targets WHERE id=$1 AND owner_user_id=$2 AND telegram_chat_id=$3 AND migrated_to_id IS NULL',
              [p.targetId, owner, p.chatId],
            )
          ).rowCount
        )
          throw new HeaderConflict();
      } else if (
        !(
          await db.query(
            'SELECT id FROM users WHERE id=$1 AND telegram_user_id=$2',
            [owner, p.chatId],
          )
        ).rowCount
      )
        throw new HeaderConflict();
      const day = headerDay(now, p);
      const next = day.due ? now : day.at;
      if (p.configId) {
        await lockHeader(db, p.configId);
        const changed = await db.query(
          `UPDATE daily_header_configs SET timezone=$4,local_time=$5,pin_enabled=$6,next_due_at=$7,revision=revision+1,updated_at=now(),telegram_chat_id=$8,target_id=$9,title=$10
          WHERE id=$1 AND owner_user_id=$2 AND revision=$3 RETURNING id`,
          [
            p.configId,
            owner,
            p.baseRevision,
            p.timezone,
            p.localTime,
            p.pin,
            next,
            p.chatId,
            p.targetId,
            p.title,
          ],
        );
        if (!changed.rowCount) throw new HeaderConflict();
        await db.query(
          "UPDATE daily_header_runs SET state='CANCELLED',last_error_code='CONFIG_CHANGED' WHERE config_id=$1 AND state='ACTIVE' AND stage<>'SENDING'",
          [p.configId],
        );
      } else {
        if (
          p.targetId &&
          (
            await db.query(
              `WITH RECURSIVE ancestors(id) AS (
          SELECT id FROM targets WHERE id=$1 AND owner_user_id=$2
          UNION SELECT t.id FROM targets t JOIN ancestors a ON t.migrated_to_id=a.id WHERE t.owner_user_id=$2)
          SELECT c.id FROM daily_header_configs c JOIN ancestors a ON c.target_id=a.id WHERE c.owner_user_id=$2`,
              [p.targetId, owner],
            )
          ).rowCount
        )
          throw new HeaderConflict(
            'برای این مقصد تنظیمات موجود است؛ از /daily همان مورد را ویرایش کنید.',
          );
        const created = await db.query(
          `INSERT INTO daily_header_configs(id,owner_user_id,target_id,telegram_chat_id,title,timezone,local_time,pin_enabled,next_due_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(owner_user_id,telegram_chat_id) DO NOTHING RETURNING id`,
          [
            randomUUID(),
            owner,
            p.targetId,
            p.chatId,
            p.title,
            p.timezone,
            p.localTime,
            p.pin,
            next,
          ],
        );
        if (!created.rowCount)
          throw new HeaderConflict(
            'برای این مقصد تنظیمات موجود است؛ از /daily همان مورد را ویرایش کنید.',
          );
      }
      await db.query('DELETE FROM daily_header_drafts WHERE owner_user_id=$1', [
        owner,
      ]);
    });
  }
  async toggle(
    owner: string,
    id: string,
    revision: number,
    enabled: boolean,
    now: string,
  ) {
    await headerTransaction(this.pool, async (db) => {
      await lockHeader(db, id);
      const c = (
        await db.query<HeaderConfig>(
          `SELECT ${headerColumns} FROM daily_header_configs WHERE id=$1 AND owner_user_id=$2 AND revision=$3 FOR UPDATE`,
          [id, owner, revision],
        )
      ).rows[0];
      if (!c) throw new HeaderConflict();
      // Resume intentionally skips the paused period, including earlier today.
      const day = headerDay(now, c);
      await db.query(
        'UPDATE daily_header_configs SET enabled=$2,revision=revision+1,next_due_at=$3,updated_at=now() WHERE id=$1',
        [id, enabled, day.due ? day.next : day.at],
      );
      await db.query(
        "UPDATE daily_header_runs SET state='CANCELLED',last_error_code='CONFIG_PAUSED' WHERE config_id=$1 AND state='ACTIVE' AND stage<>'SENDING'",
        [id],
      );
    });
  }
  async cancel(owner: string) {
    return (
      (
        await this.pool.query(
          'DELETE FROM daily_header_drafts WHERE owner_user_id=$1',
          [owner],
        )
      ).rowCount !== 0
    );
  }
}
