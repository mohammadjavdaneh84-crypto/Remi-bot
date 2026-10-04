import type { PoolClient } from 'pg';

/** Caller owns the reminder row lock. Started executions are deliberately untouched. */
export async function cancelPending(
  db: PoolClient,
  reminder: string,
  reason: string,
  scheduledOnly = false,
) {
  const executions = await db.query<{ id: string }>(
    `SELECT id FROM executions WHERE reminder_id=$1 AND state='PENDING'
    AND (NOT $2::boolean OR trigger_kind='SCHEDULED') ORDER BY id FOR UPDATE`,
    [reminder, scheduledOnly],
  );
  for (const { id } of executions.rows) {
    await db.query(
      "UPDATE deliveries SET state='CANCELLED',completed_at=now(),next_attempt_at=NULL,last_error_code=$2 WHERE execution_id=$1 AND state IN ('PENDING','FAILED_RETRYABLE')",
      [id, reason],
    );
    await db.query(
      "UPDATE executions SET state='CANCELLED',completed_at=now(),cancel_reason=$2 WHERE id=$1",
      [id, reason],
    );
  }
}
