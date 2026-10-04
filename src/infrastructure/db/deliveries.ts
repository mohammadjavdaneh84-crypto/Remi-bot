import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { reportSafely, type ReportEvent } from '../logging/events.js';
import {
  deliveryUnits,
  type CanonicalContent,
  type DeliveryFailure,
  type DeliveryRepository,
  type DeliverySession,
  type DeliveryUnit,
} from '../../app/delivery/model.js';

async function transaction<T>(
  db: PoolClient,
  run: () => Promise<T>,
): Promise<T> {
  await db.query('BEGIN');
  try {
    const value = await run();
    await db.query('COMMIT');
    return value;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}
async function aggregate(db: PoolClient, execution: string) {
  // Caller holds the execution row lock: target workers cannot publish stale aggregates.
  await db.query(
    `UPDATE executions SET state=CASE
    WHEN EXISTS(SELECT 1 FROM deliveries WHERE execution_id=$1 AND state IN ('PENDING','PROCESSING','FAILED_RETRYABLE')) THEN 'PROCESSING'
    WHEN NOT EXISTS(SELECT 1 FROM deliveries WHERE execution_id=$1 AND NOT (state='SUCCEEDED' OR (state='CANCELLED' AND COALESCE(last_error_code,'')='MERGED_TARGET'))) THEN 'SUCCEEDED'
    WHEN NOT EXISTS(SELECT 1 FROM deliveries WHERE execution_id=$1 AND state<>'CANCELLED') THEN 'CANCELLED'
    WHEN EXISTS(SELECT 1 FROM deliveries WHERE execution_id=$1 AND state='SUCCEEDED') OR EXISTS(
      SELECT 1 FROM delivery_items i JOIN deliveries d ON d.id=i.delivery_id WHERE d.execution_id=$1 AND i.state='SENT') THEN 'PARTIAL_FAILED'
    ELSE 'FAILED' END,
    completed_at=CASE WHEN EXISTS(SELECT 1 FROM deliveries WHERE execution_id=$1 AND state IN ('PENDING','PROCESSING','FAILED_RETRYABLE'))
      THEN NULL ELSE now() END WHERE id=$1`,
    [execution],
  );
}
interface Candidate {
  id: string;
  execution_id: string;
  reminder_id: string;
}
interface Claimed {
  id: string;
  owner_user_id: string;
  target_id: string;
  reminder_version_id: string;
  state: string;
  attempt_count: number;
}

export class PgDeliveryRepository implements DeliveryRepository {
  constructor(
    private readonly pool: Pool,
    private readonly report: ReportEvent = () => {},
  ) {}
  async runNext(
    now: string,
    work: (session: DeliverySession) => Promise<void>,
  ): Promise<boolean> {
    const db = await this.pool.connect();
    let lock: string | null = null,
      broken = false;
    const onError = () => {
      broken = true;
    };
    db.on('error', onError);
    try {
      const candidates = await db.query<Candidate>(
        `SELECT d.id,d.execution_id,e.reminder_id
        FROM deliveries d JOIN executions e ON e.id=d.execution_id
        WHERE e.state IN ('PENDING','PROCESSING') AND (d.state IN ('PENDING','PROCESSING') OR (d.state='FAILED_RETRYABLE' AND d.next_attempt_at<=$1))
          AND NOT EXISTS(SELECT 1 FROM deliveries older JOIN executions oe ON oe.id=older.execution_id
            WHERE older.target_id=d.target_id AND older.state IN ('PENDING','PROCESSING','FAILED_RETRYABLE')
            AND (oe.scheduled_for,oe.created_at,oe.id)<(e.scheduled_for,e.created_at,e.id))
        ORDER BY e.scheduled_for,e.created_at,e.id,d.position,d.id LIMIT 100`,
        [now],
      );
      for (const candidate of candidates.rows) {
        const acquired = await db.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',
          [`delivery:${candidate.id}`],
        );
        if (!acquired.rows[0]!.locked) continue;
        lock = candidate.id;
        const claimed = await transaction(db, async () => {
          // Lifecycle writers use the same reminder -> execution -> delivery lock order.
          const reminder = (
            await db.query<{ status: string; current_version_id: string }>(
              'SELECT status,current_version_id FROM reminders WHERE id=$1 FOR UPDATE',
              [candidate.reminder_id],
            )
          ).rows[0]!;
          const execution = (
            await db.query<{
              state: string;
              reminder_version_id: string;
              trigger_kind: string;
            }>(
              'SELECT state,reminder_version_id,trigger_kind FROM executions WHERE id=$1 FOR UPDATE',
              [candidate.execution_id],
            )
          ).rows[0]!;
          const row = (
            await db.query<Claimed>(
              `SELECT d.id,d.target_id,d.state,d.attempt_count,r.owner_user_id,e.reminder_version_id
            FROM deliveries d JOIN executions e ON e.id=d.execution_id JOIN reminders r ON r.id=e.reminder_id
            WHERE d.id=$1 AND (d.state IN ('PENDING','PROCESSING') OR (d.state='FAILED_RETRYABLE' AND d.next_attempt_at<=$2))
            FOR UPDATE OF d SKIP LOCKED`,
              [candidate.id, now],
            )
          ).rows[0];
          if (!row) return null;
          if (
            execution.state === 'CANCELLED' ||
            (execution.state === 'PENDING' &&
              (reminder.status === 'DELETED' ||
                (reminder.status === 'PAUSED' &&
                  execution.trigger_kind === 'SCHEDULED') ||
                reminder.current_version_id !== execution.reminder_version_id))
          ) {
            await db.query(
              "UPDATE deliveries SET state='CANCELLED',completed_at=now(),last_error_code='INACTIVE_DEFINITION' WHERE execution_id=$1 AND state='PENDING'",
              [candidate.execution_id],
            );
            await aggregate(db, candidate.execution_id);
            return { recovered: true as const };
          }
          const inFlight = await db.query(
            "UPDATE delivery_items SET state='UNKNOWN',last_error_code='INTERRUPTED_SEND',updated_at=now() WHERE delivery_id=$1 AND state='SENDING' RETURNING id",
            [row.id],
          );
          if (inFlight.rowCount) {
            await db.query(
              "UPDATE deliveries SET state='UNKNOWN',last_error_code='INTERRUPTED_SEND',completed_at=now(),next_attempt_at=NULL WHERE id=$1",
              [row.id],
            );
            await aggregate(db, candidate.execution_id);
            return { recovered: true as const };
          }
          const existing = await db.query(
            'SELECT id FROM delivery_items WHERE delivery_id=$1',
            [row.id],
          );
          if (!existing.rowCount) {
            const content = await db.query<CanonicalContent>(
              `SELECT c.id,c.archive_id AS "archiveId",c.archive_position AS "archivePosition",
              a.storage_chat_id AS "storageChatId",i.storage_message_id AS "messageId",i.content_type AS kind,i.media_group_key AS album
              FROM content_items c JOIN content_archives a ON a.id=c.archive_id
              JOIN archived_content_items i ON i.archive_id=c.archive_id AND i.position=c.archive_position
              WHERE c.reminder_version_id=$1 AND a.state='READY' ORDER BY c.position`,
              [row.reminder_version_id],
            );
            for (const unit of deliveryUnits(
              content.rows.map((c) => ({
                ...c,
                messageId: Number(c.messageId),
              })),
            )) {
              const id = randomUUID();
              await db.query(
                `INSERT INTO delivery_items(id,delivery_id,sequence,storage_chat_id,storage_message_ids,content_kinds)
                VALUES($1,$2,$3,$4,$5,$6)`,
                [
                  id,
                  row.id,
                  unit.sequence,
                  unit.storageChatId,
                  JSON.stringify(unit.messageIds),
                  JSON.stringify(unit.kinds),
                ],
              );
              for (const [position, contentId] of unit.contentIds.entries())
                await db.query(
                  `INSERT INTO delivery_item_contents(delivery_id,delivery_item_id,content_item_id,position) VALUES($1,$2,$3,$4)`,
                  [row.id, id, contentId, position],
                );
            }
          }
          await db.query(
            "UPDATE executions SET state='PROCESSING',started_at=COALESCE(started_at,now()) WHERE id=$1",
            [candidate.execution_id],
          );
          await db.query(
            "UPDATE deliveries SET state='PROCESSING',attempt_count=attempt_count+1,started_at=COALESCE(started_at,now()),next_attempt_at=NULL WHERE id=$1",
            [row.id],
          );
          return {
            recovered: false as const,
            row: { ...row, attempt_count: row.attempt_count + 1 },
          };
        });
        if (!claimed) {
          await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [
            `delivery:${lock}`,
          ]);
          lock = null;
          continue;
        }
        if (claimed.recovered) {
          reportSafely(this.report, {
            event: 'delivery.recovered',
            delivery_id: candidate.id,
            execution_id: candidate.execution_id,
          });
          return true;
        }
        const row = claimed.row;
        const trace = (event: string, code?: string) =>
          reportSafely(this.report, {
            event,
            delivery_id: row.id,
            execution_id: candidate.execution_id,
            reminder_id: candidate.reminder_id,
            target_id: row.target_id,
            ...(code ? { code } : {}),
          });
        trace('delivery.started');
        const units = (
          await db.query<DeliveryUnit>(
            `SELECT id,sequence,storage_chat_id AS "storageChatId",
          storage_message_ids AS "messageIds",content_kinds AS kinds,state,attempt_count AS attempts,
          ARRAY(SELECT content_item_id FROM delivery_item_contents WHERE delivery_item_id=delivery_items.id ORDER BY position) AS "contentIds"
          FROM delivery_items WHERE delivery_id=$1 ORDER BY sequence`,
            [row.id],
          )
        ).rows;
        const finish = async (
          state: string,
          code: string | null,
          next: string | null,
          unit?: DeliveryUnit | null,
          knownIds: number[] = [],
        ) => {
          await transaction(db, async () => {
            await db.query('SELECT id FROM executions WHERE id=$1 FOR UPDATE', [
              candidate.execution_id,
            ]);
            if (unit)
              await db.query(
                `UPDATE delivery_items SET state=$2,last_error_code=$3,sent_message_ids=$4,updated_at=now() WHERE id=$1 AND delivery_id=$5`,
                [unit.id, state, code, JSON.stringify(knownIds), row.id],
              );
            await db.query(
              `UPDATE deliveries SET state=$2,last_error_code=$3,last_error_message=NULL,next_attempt_at=$4,
              completed_at=CASE WHEN $2='FAILED_RETRYABLE' THEN NULL ELSE now() END WHERE id=$1`,
              [row.id, state, code, next],
            );
            await aggregate(db, candidate.execution_id);
          });
          trace(
            state === 'FAILED_RETRYABLE'
              ? 'delivery.retry_scheduled'
              : state === 'UNKNOWN'
                ? 'delivery.unknown'
                : 'delivery.finished',
            code ?? undefined,
          );
        };
        await work({
          id: row.id,
          ownerId: row.owner_user_id,
          targetId: row.target_id,
          attempts: row.attempt_count,
          units,
          destination: async (target) =>
            transaction(db, async () => {
              await db.query(
                'SELECT id FROM executions WHERE id=$1 FOR UPDATE',
                [candidate.execution_id],
              );
              const duplicate = await db.query(
                "SELECT id FROM deliveries WHERE execution_id=$1 AND resolved_target_id=$2 AND id<>$3 AND state<>'CANCELLED'",
                [candidate.execution_id, target.id, row.id],
              );
              if (duplicate.rowCount) {
                await db.query(
                  "UPDATE deliveries SET state='CANCELLED',last_error_code='MERGED_TARGET',completed_at=now() WHERE id=$1",
                  [row.id],
                );
                await aggregate(db, candidate.execution_id);
                return false;
              }
              await db.query(
                'UPDATE deliveries SET resolved_target_id=$2,destination_chat_id=$3,target_title=$4 WHERE id=$1',
                [row.id, target.id, target.chatId, target.title],
              );
              return true;
            }),
          sending: async (unit, chatId) => {
            const updated = await db.query(
              `UPDATE delivery_items SET state='SENDING',attempt_count=attempt_count+1,destination_chat_id=$2,last_error_code=NULL,updated_at=now()
              WHERE id=$1 AND delivery_id=$3 AND state IN ('PENDING','FAILED_RETRYABLE') RETURNING id`,
              [unit.id, chatId, row.id],
            );
            if (updated.rowCount !== 1)
              throw new Error('Invalid delivery item transition');
            unit.attempts++;
          },
          sent: async (unit, ids) => {
            const updated = await db.query(
              "UPDATE delivery_items SET state='SENT',sent_message_ids=$2,last_error_code=NULL,updated_at=now() WHERE id=$1 AND delivery_id=$3 AND state='SENDING' RETURNING id",
              [unit.id, JSON.stringify(ids), row.id],
            );
            if (updated.rowCount !== 1)
              throw new Error('Invalid delivery result transition');
            trace('delivery.item.sent');
          },
          fail: (
            unit: DeliveryUnit | null,
            failure: DeliveryFailure,
            next: string | null,
          ) =>
            finish(failure.state, failure.code, next, unit, failure.knownIds),
          complete: () => finish('SUCCEEDED', null, null),
        });
        return true;
      }
      return false;
    } finally {
      if (lock && !broken) {
        try {
          await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [
            `delivery:${lock}`,
          ]);
        } catch {
          broken = true;
        }
      }
      db.removeListener('error', onError);
      db.release(broken);
    }
  }
}
