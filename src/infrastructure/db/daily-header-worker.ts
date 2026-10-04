import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  HeaderConfig,
  HeaderTransport,
} from '../../app/daily-header/model.js';
import { headerDay } from '../../domain/daily-header/schedule.js';
import { retryAt } from '../../app/delivery/model.js';
import { classifyDelivery } from '../telegram/delivery.js';
import { reportSafely, type ReportEvent } from '../logging/events.js';
import { headerColumns } from './daily-headers.js';

interface Run {
  id: string;
  local_date: string;
  timezone: string;
  destination_chat_id: string;
  pin_enabled: boolean;
  stage: 'SEND' | 'SENDING' | 'PIN' | 'UNPIN' | 'DONE';
  attempt_count: number;
  message_id: string | null;
  previous_message_id: string | null;
  previous_chat_id: string | null;
}
/** One connection retains a config advisory lock; no transaction spans Telegram I/O. */
export class PgDailyHeaderWorker {
  constructor(
    private readonly pool: Pool,
    private readonly transport: HeaderTransport,
    private readonly maxAttempts = 5,
    private readonly report: ReportEvent = () => {},
    private readonly clock = () => new Date().toISOString(),
  ) {}

  async runOne(): Promise<boolean> {
    const now = this.clock();
    const db = await this.pool.connect();
    let locked: string | null = null;
    let broken = false;
    const onError = () => {
      broken = true;
    };
    db.on('error', onError);
    try {
      const candidates = await db.query<{ id: string }>(
        `SELECT c.id FROM daily_header_configs c WHERE
        (c.enabled AND c.next_due_at<=$1) OR EXISTS(SELECT 1 FROM daily_header_runs r WHERE r.config_id=c.id AND r.state='ACTIVE' AND r.next_attempt_at<=$1)
        ORDER BY c.next_due_at,c.id LIMIT 100`,
        [now],
      );
      for (const { id } of candidates.rows) {
        const lock = await db.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',
          ['header:' + id],
        );
        if (!lock.rows[0]!.locked) continue;
        locked = id;
        const config = (
          await db.query<HeaderConfig>(
            `SELECT ${headerColumns} FROM daily_header_configs WHERE id=$1`,
            [id],
          )
        ).rows[0]!;
        const day = headerDay(now, config);
        // Recover an ambiguous send even if config was subsequently disabled.
        await db.query(
          "UPDATE daily_header_runs SET state='UNKNOWN',last_error_code='INTERRUPTED_SEND',updated_at=now() WHERE config_id=$1 AND state='ACTIVE' AND stage='SENDING'",
          [id],
        );
        await db.query(
          `UPDATE daily_header_runs SET state='CANCELLED',last_error_code='DAY_EXPIRED',updated_at=now()
          WHERE config_id=$1 AND state='ACTIVE' AND (local_date<>$2::date OR NOT $3::boolean)`,
          [id, day.date, config.enabled],
        );
        if (config.enabled && config.nextDue.getTime() <= Date.parse(now)) {
          await db.query('BEGIN');
          try {
            if (day.due)
              await db.query(
                `INSERT INTO daily_header_runs(id,config_id,local_date,timezone,destination_chat_id,pin_enabled,next_attempt_at)
              VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(config_id,local_date) DO NOTHING`,
                [
                  randomUUID(),
                  id,
                  day.date,
                  config.timezone,
                  config.chatId,
                  config.pin,
                  now,
                ],
              );
            await db.query(
              'UPDATE daily_header_configs SET next_due_at=$2 WHERE id=$1',
              [id, day.due ? day.next : day.at],
            );
            await db.query('COMMIT');
          } catch (error) {
            await db.query('ROLLBACK');
            throw error;
          }
        }
        const run = (
          await db.query<Run>(
            `SELECT r.*,r.local_date::text AS local_date FROM daily_header_runs r WHERE config_id=$1 AND state='ACTIVE' AND next_attempt_at<=$2 ORDER BY r.local_date LIMIT 1`,
            [id, now],
          )
        ).rows[0];
        if (run) {
          await this.deliver(db, config, run);
          return true;
        }
        await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [
          'header:' + id,
        ]);
        locked = null;
      }
      return false;
    } finally {
      if (locked && !broken)
        try {
          await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [
            'header:' + locked,
          ]);
        } catch {
          broken = true;
        }
      db.removeListener('error', onError);
      db.release(broken);
    }
  }
  private async deliver(db: PoolClient, config: HeaderConfig, run: Run) {
    const trace = (event: string, code?: string) =>
      reportSafely(this.report, {
        event,
        config_id: config.id,
        ...(code ? { code } : {}),
      });
    const fail = async (error: unknown, sending: boolean) => {
      const f = classifyDelivery(error, sending);
      const retry =
        f.state === 'FAILED_RETRYABLE' && run.attempt_count < this.maxAttempts;
      const state = retry
        ? 'ACTIVE'
        : f.state === 'UNKNOWN'
          ? 'UNKNOWN'
          : 'FAILED';
      // Pin/unpin can safely repeat the explicit own message, unlike sendMessage.
      await db.query(
        `UPDATE daily_header_runs SET state=$2,stage=$3,next_attempt_at=$4,last_error_code=$5,updated_at=now() WHERE id=$1`,
        [
          run.id,
          state,
          run.stage === 'SENDING' && retry ? 'SEND' : run.stage,
          retry
            ? retryAt(this.clock(), run.attempt_count, f.retryAfter)
            : this.clock(),
          f.code,
        ],
      );
      trace(
        retry ? 'daily_header.retry_scheduled' : 'daily_header.failed',
        f.code,
      );
    };
    if (run.stage === 'SEND') {
      await db.query(
        'UPDATE daily_header_runs SET attempt_count=attempt_count+1 WHERE id=$1',
        [run.id],
      );
      run.attempt_count++;
      let destination: { chatId: string; title: string };
      try {
        destination = await this.transport.check(
          config.ownerId,
          config.targetId,
          config.chatId,
          run.pin_enabled,
        );
      } catch (error) {
        await fail(error, false);
        return;
      }
      // Snapshot the resolved migration destination before sending, while keeping prior pin chat explicit.
      await db.query(
        `UPDATE daily_header_runs SET stage='SENDING',destination_chat_id=$2,updated_at=now() WHERE id=$1`,
        [run.id, destination.chatId],
      );
      run.stage = 'SENDING';
      run.destination_chat_id = destination.chatId;
      let message: number;
      try {
        message = await this.transport.send(destination.chatId, run.local_date);
        if (!Number.isSafeInteger(message) || message < 1)
          throw new Error('Invalid header response');
      } catch (error) {
        await fail(error, true);
        return;
      }
      // Persistence failures escape: recovery observes SENDING and never resends.
      await db.query(
        `UPDATE daily_header_runs SET stage=$2,message_id=$3,attempt_count=0,updated_at=now() WHERE id=$1`,
        [run.id, run.pin_enabled ? 'PIN' : 'DONE', message],
      );
      run.message_id = String(message);
      run.stage = run.pin_enabled ? 'PIN' : 'DONE';
      run.attempt_count = 0;
      trace('daily_header.sent');
    }
    if (run.stage === 'PIN') {
      await db.query(
        'UPDATE daily_header_runs SET attempt_count=attempt_count+1 WHERE id=$1',
        [run.id],
      );
      run.attempt_count++;
      try {
        await this.transport.pin(
          run.destination_chat_id,
          Number(run.message_id),
        );
      } catch (error) {
        await fail(error, false);
        return;
      }
      await db.query('BEGIN');
      try {
        const previous = (
          await db.query<{
            last_pinned_message_id: string | null;
            last_pinned_chat_id: string | null;
          }>(
            'SELECT last_pinned_message_id,last_pinned_chat_id FROM daily_header_configs WHERE id=$1 FOR UPDATE',
            [config.id],
          )
        ).rows[0]!;
        run.previous_message_id = previous.last_pinned_message_id;
        run.previous_chat_id = previous.last_pinned_chat_id;
        await db.query(
          `UPDATE daily_header_runs SET stage='UNPIN',previous_message_id=$2,previous_chat_id=$3,attempt_count=0,updated_at=now() WHERE id=$1`,
          [run.id, run.previous_message_id, run.previous_chat_id],
        );
        await db.query(
          'UPDATE daily_header_configs SET last_pinned_message_id=$2,last_pinned_chat_id=$3 WHERE id=$1',
          [config.id, run.message_id, run.destination_chat_id],
        );
        await db.query('COMMIT');
      } catch (error) {
        await db.query('ROLLBACK');
        throw error;
      }
      run.stage = 'UNPIN';
      run.attempt_count = 0;
    }
    if (
      run.stage === 'UNPIN' &&
      run.previous_message_id &&
      run.previous_chat_id &&
      !(
        run.previous_message_id === run.message_id &&
        run.previous_chat_id === run.destination_chat_id
      )
    ) {
      await db.query(
        'UPDATE daily_header_runs SET attempt_count=attempt_count+1 WHERE id=$1',
        [run.id],
      );
      run.attempt_count++;
      try {
        await this.transport.unpin(
          run.previous_chat_id,
          Number(run.previous_message_id),
        );
      } catch (error) {
        await fail(error, false);
        return;
      }
    }
    await db.query(
      "UPDATE daily_header_runs SET stage='DONE',state='SUCCEEDED',last_error_code=NULL,updated_at=now() WHERE id=$1",
      [run.id],
    );
    trace('daily_header.completed');
  }
}
