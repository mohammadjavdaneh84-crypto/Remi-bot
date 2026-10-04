import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { Temporal } from '@js-temporal/polyfill';
import {
  planDue,
  type MissedPolicy,
} from '../../domain/schedule/production.js';
import { ruleSchema } from '../../domain/schedule/rule.js';
import type { ProductionResult } from '../../app/scheduler/loop.js';
export class PgScheduleProducer {
  constructor(
    private readonly pool: Pool,
    private readonly catchUpLimit = 10,
    private readonly batchSize = 25,
  ) {
    if (
      !Number.isInteger(catchUpLimit) ||
      catchUpLimit < 1 ||
      catchUpLimit > 1000 ||
      !Number.isInteger(batchSize) ||
      batchSize < 1 ||
      batchSize > 1000
    )
      throw new RangeError('Invalid scheduler bounds');
  }
  async tick(at: string): Promise<ProductionResult> {
    const now = Temporal.Instant.from(at).toString();
    const result = { reminders: 0, executions: 0, blockedRules: 0 };
    // A reminder lock keeps all contributing rules together, even across producers.
    for (let i = 0; i < this.batchSize; i++) {
      const db = await this.pool.connect();
      try {
        await db.query('BEGIN');
        const claimed = await db.query<{
          id: string;
          version_id: string;
          timezone: string;
          missed_run_policy: MissedPolicy;
        }>(
          `
          SELECT r.id, v.id AS version_id, v.timezone, v.missed_run_policy
          FROM reminders r JOIN reminder_versions v ON v.id=r.current_version_id
          WHERE r.status='ACTIVE' AND v.activated_at IS NOT NULL AND v.retired_at IS NULL
            AND v.activated_at <= $1 AND EXISTS (
              SELECT 1 FROM schedule_rules s JOIN schedule_cursors c ON c.schedule_rule_id=s.id
              WHERE s.reminder_version_id=v.id AND s.enabled AND c.active AND c.next_due_at <= $1)
          ORDER BY r.id LIMIT 1 FOR UPDATE OF r SKIP LOCKED`,
          [now],
        );
        const reminder = claimed.rows[0];
        if (!reminder) {
          await db.query('COMMIT');
          break;
        }
        const cursors = await db.query<{
          id: string;
          config: unknown;
          next_due_at: string;
          consumed_count: number;
        }>(
          `
          SELECT s.id,s.config,c.next_due_at::text,c.consumed_count
          FROM schedule_rules s JOIN schedule_cursors c ON c.schedule_rule_id=s.id
          WHERE s.reminder_version_id=$1 AND s.enabled AND c.active AND c.next_due_at <= $2
          ORDER BY s.id FOR UPDATE OF c`,
          [reminder.version_id, now],
        );
        const plans = cursors.rows.map((c) => ({
          id: c.id,
          plan: planDue(
            ruleSchema.parse(c.config),
            { timezone: reminder.timezone, calendarSystem: 'gregorian' },
            c.next_due_at,
            c.consumed_count,
            now,
            reminder.missed_run_policy,
            this.catchUpLimit,
          ),
        }));
        const merged = new Map<string, string[]>();
        for (const { id, plan } of plans)
          for (const at of plan.occurrences)
            merged.set(at, [...(merged.get(at) ?? []), id]);
        let created = 0;
        for (const [scheduledFor, ids] of [...merged].sort(([a], [b]) =>
          Temporal.Instant.compare(a, b),
        )) {
          const execution = await db.query<{ id: string }>(
            `
            INSERT INTO executions(id,reminder_id,reminder_version_id,scheduled_for,trigger_kind,dedupe_key)
            VALUES($1,$2,$3,$4,'SCHEDULED',$5) ON CONFLICT DO NOTHING RETURNING id`,
            [
              randomUUID(),
              reminder.id,
              reminder.version_id,
              scheduledFor,
              `scheduled:${reminder.version_id}:${scheduledFor}`,
            ],
          );
          // An atomic earlier commit always moved the cursors too. A conflict here indicates
          // damaged/reset runtime state; fail closed instead of consuming counts again.
          if (!execution.rows[0])
            throw new Error('Scheduler cursor/execution invariant violated');
          const executionId = execution.rows[0].id;
          for (const id of ids)
            await db.query(
              `INSERT INTO execution_rules(execution_id,schedule_rule_id,reminder_version_id) VALUES($1,$2,$3)`,
              [executionId, id, reminder.version_id],
            );
          await db.query(
            `INSERT INTO deliveries(id,execution_id,target_id,position)
            SELECT gen_random_uuid(),$1,target_id,position FROM reminder_version_targets WHERE reminder_version_id=$2`,
            [executionId, reminder.version_id],
          );
          created++;
        }
        for (const { id, plan } of plans)
          await db.query(
            `UPDATE schedule_cursors SET next_due_at=$2,
          consumed_count=$3, active=$4, blocked_reason=$5,
          last_due_at=COALESCE($6::timestamptz,last_due_at),updated_at=$7 WHERE schedule_rule_id=$1`,
            [
              id,
              plan.nextDueAt,
              plan.consumedCount,
              !!plan.nextDueAt && !plan.blocked,
              plan.blocked ? 'CATCH_UP_LIMIT' : null,
              plan.occurrences.at(-1) ?? null,
              now,
            ],
          );
        await db.query('COMMIT');
        result.reminders++;
        result.executions += created;
        result.blockedRules += plans.filter(({ plan }) => plan.blocked).length;
      } catch (error) {
        await db.query('ROLLBACK');
        throw error;
      } finally {
        db.release();
      }
    }
    return result;
  }
}
