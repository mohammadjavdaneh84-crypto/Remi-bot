import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { nextOccurrence } from '../../domain/schedule/recurrence.js';
import { ruleSchema } from '../../domain/schedule/rule.js';
import {
  ManagementConflict,
  type ManagementAction,
  type ManagementRepository,
  type ReminderSummary,
} from '../../app/management/model.js';
import type { CanonicalContent } from '../../app/delivery/model.js';
import { cancelPending } from './lifecycle.js';
const summary = `SELECT r.id,r.status,r.revision,v.name,v.timezone,
  (SELECT min(c.next_due_at)::text FROM schedule_cursors c JOIN schedule_rules s ON s.id=c.schedule_rule_id WHERE s.reminder_version_id=v.id AND s.enabled AND c.active) AS "nextDue",
  (SELECT count(*)::int FROM schedule_rules WHERE reminder_version_id=v.id) AS rules,
  (SELECT count(*)::int FROM reminder_version_targets WHERE reminder_version_id=v.id) AS targets
  FROM reminders r JOIN reminder_versions v ON v.id=r.current_version_id`;
export class PgManagementRepository implements ManagementRepository {
  constructor(private readonly pool: Pool) {}
  async list(owner: string, page: number) {
    if (!Number.isSafeInteger(page) || page < 0 || page > 10000)
      throw new RangeError('Invalid page');
    const result = await this.pool.query<ReminderSummary>(
      `${summary} WHERE r.owner_user_id=$1 AND r.status<>'DELETED' ORDER BY r.created_at DESC,r.id LIMIT 11 OFFSET $2`,
      [owner, page * 10],
    );
    return { rows: result.rows.slice(0, 10), hasNext: result.rows.length > 10 };
  }
  async get(owner: string, id: string) {
    return (
      (
        await this.pool.query<ReminderSummary>(
          `${summary} WHERE r.id=$1 AND r.owner_user_id=$2 AND r.status<>'DELETED'`,
          [id, owner],
        )
      ).rows[0] ?? null
    );
  }
  async content(owner: string, id: string) {
    const result = await this.pool.query<CanonicalContent>(
      `SELECT c.id,c.archive_id AS "archiveId",c.archive_position AS "archivePosition",a.storage_chat_id AS "storageChatId",
      i.storage_message_id AS "messageId",i.content_type AS kind,i.media_group_key AS album FROM reminders r
      JOIN content_items c ON c.reminder_version_id=r.current_version_id JOIN content_archives a ON a.id=c.archive_id
      JOIN archived_content_items i ON i.archive_id=c.archive_id AND i.position=c.archive_position
      WHERE r.id=$1 AND r.owner_user_id=$2 AND r.status<>'DELETED' ORDER BY c.position`,
      [id, owner],
    );
    return result.rows.map((c) => ({ ...c, messageId: Number(c.messageId) }));
  }
  async act(
    owner: string,
    id: string,
    revision: number,
    action: ManagementAction,
    updateId: number,
    now: string,
  ) {
    if (
      !Number.isSafeInteger(updateId) ||
      updateId < 0 ||
      !Number.isSafeInteger(revision) ||
      revision < 0
    )
      throw new RangeError('Invalid action');
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const ownerRow = await db.query(
        'SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE',
        [owner],
      );
      if (!ownerRow.rowCount)
        throw new ManagementConflict('یادآور در دسترس نیست.');
      const receipt = await db.query(
        'INSERT INTO management_updates(owner_user_id,update_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING update_id',
        [owner, updateId],
      );
      if (!receipt.rowCount) {
        await db.query('COMMIT');
        return null;
      }
      const r = (
        await db.query<{
          status: string;
          revision: number;
          current_version_id: string;
          timezone: string;
          name: string;
        }>(
          `SELECT r.status,r.revision,r.current_version_id,v.timezone,v.name FROM reminders r JOIN reminder_versions v ON v.id=r.current_version_id
        WHERE r.id=$1 AND r.owner_user_id=$2 AND r.status<>'DELETED' FOR UPDATE OF r`,
          [id, owner],
        )
      ).rows[0];
      if (!r || r.revision !== revision)
        throw new ManagementConflict(
          'این دکمه قدیمی است؛ فهرست یادآورها را تازه کنید.',
        );
      let result = id;
      switch (action) {
        case 'pause':
        case 'delete': {
          await cancelPending(
            db,
            id,
            action === 'pause' ? 'PAUSED' : 'DELETED',
            action === 'pause',
          );
          await db.query(
            'UPDATE schedule_cursors SET active=false,updated_at=now() WHERE schedule_rule_id IN (SELECT id FROM schedule_rules WHERE reminder_version_id=$1)',
            [r.current_version_id],
          );
          await db.query(
            `UPDATE reminders SET status=$2,paused_at=CASE WHEN $2='PAUSED' THEN $3::timestamptz ELSE paused_at END,
            deleted_at=CASE WHEN $2='DELETED' THEN $3::timestamptz ELSE deleted_at END WHERE id=$1`,
            [id, action === 'pause' ? 'PAUSED' : 'DELETED', now],
          );
          break;
        }
        case 'resume': {
          if (r.status !== 'PAUSED')
            throw new ManagementConflict('یادآور از قبل فعال است.');
          const rules = await db.query<{
            id: string;
            config: unknown;
            enabled: boolean;
            consumed_count: number;
          }>(
            `SELECT s.id,s.config,s.enabled,c.consumed_count FROM schedule_rules s JOIN schedule_cursors c ON c.schedule_rule_id=s.id WHERE s.reminder_version_id=$1 ORDER BY s.id FOR UPDATE OF c`,
            [r.current_version_id],
          );
          for (const rule of rules.rows) {
            const next = nextOccurrence(
              ruleSchema.parse(rule.config),
              now,
              { timezone: r.timezone, calendarSystem: 'gregorian' },
              rule.consumed_count,
            );
            await db.query(
              'UPDATE schedule_cursors SET next_due_at=$2,active=$3,blocked_reason=NULL,updated_at=now() WHERE schedule_rule_id=$1',
              [rule.id, next, !!next && rule.enabled],
            );
          }
          await db.query(
            "UPDATE reminders SET status='ACTIVE',paused_at=NULL WHERE id=$1",
            [id],
          );
          break;
        }
        case 'run': {
          const execution = randomUUID();
          await db.query(
            `INSERT INTO executions(id,reminder_id,reminder_version_id,scheduled_for,trigger_kind,dedupe_key)
            VALUES($1,$2,$3,$4,'MANUAL',$5)`,
            [
              execution,
              id,
              r.current_version_id,
              now,
              `manual:${owner}:${updateId}`,
            ],
          );
          await db.query(
            'INSERT INTO deliveries(id,execution_id,target_id,position) SELECT gen_random_uuid(),$1,target_id,position FROM reminder_version_targets WHERE reminder_version_id=$2',
            [execution, r.current_version_id],
          );
          break;
        }
        case 'duplicate': {
          result = randomUUID();
          const version = randomUUID();
          await db.query(
            "INSERT INTO reminders(id,owner_user_id,status,paused_at) VALUES($1,$2,'PAUSED',$3)",
            [result, owner, now],
          );
          await db.query(
            `INSERT INTO reminder_versions(id,reminder_id,version_no,name,timezone,calendar_system,missed_run_policy)
            SELECT $1,$2,1,$4,timezone,calendar_system,missed_run_policy FROM reminder_versions WHERE id=$3`,
            [
              version,
              result,
              r.current_version_id,
              ('کپی ' + r.name).slice(0, 100).replace(/[\uD800-\uDBFF]$/, ''),
            ],
          );
          await db.query(
            'INSERT INTO content_items(id,reminder_version_id,position,archive_id,archive_position) SELECT gen_random_uuid(),$1,position,archive_id,archive_position FROM content_items WHERE reminder_version_id=$2',
            [version, r.current_version_id],
          );
          await db.query(
            'INSERT INTO schedule_rules(id,reminder_version_id,position,config,enabled) SELECT gen_random_uuid(),$1,position,config,enabled FROM schedule_rules WHERE reminder_version_id=$2',
            [version, r.current_version_id],
          );
          await db.query(
            'INSERT INTO schedule_cursors(schedule_rule_id,active) SELECT id,false FROM schedule_rules WHERE reminder_version_id=$1',
            [version],
          );
          await db.query(
            'INSERT INTO reminder_version_targets(reminder_version_id,target_id,position) SELECT $1,target_id,position FROM reminder_version_targets WHERE reminder_version_id=$2',
            [version, r.current_version_id],
          );
          await db.query(
            'UPDATE reminder_versions SET activated_at=$2 WHERE id=$1',
            [version, now],
          );
          await db.query(
            'UPDATE reminders SET current_version_id=$2 WHERE id=$1',
            [result, version],
          );
          break;
        }
        case 'preview':
          break;
        default:
          throw new Error('Invalid management action');
      }
      if (action !== 'preview')
        await db.query(
          'UPDATE reminders SET revision=revision+1,updated_at=now() WHERE id=$1',
          [id],
        );
      await db.query('COMMIT');
      return result;
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
    }
  }
}
