import type { Pool } from 'pg';
import type {
  HistoryEntry,
  HistoryRepository,
} from '../../app/delivery/history.js';
export class PgHistoryRepository implements HistoryRepository {
  constructor(private readonly pool: Pool) {}
  async page(owner: string, page: number, reminder?: string) {
    if (!Number.isInteger(page) || page < 0 || page > 10000)
      throw new RangeError('Invalid history page');
    if (reminder && !/^[0-9a-f-]{36}$/i.test(reminder))
      throw new RangeError('Invalid reminder');
    const rows = await this.pool.query<HistoryEntry>(
      `SELECT e.id,e.reminder_id AS "reminderId",v.name,v.timezone,e.scheduled_for::text AS "scheduledFor",
      e.trigger_kind AS trigger,e.state FROM executions e JOIN reminders r ON r.id=e.reminder_id
      JOIN reminder_versions v ON v.id=e.reminder_version_id WHERE r.owner_user_id=$1 AND ($2::uuid IS NULL OR r.id=$2)
      ORDER BY e.scheduled_for DESC,e.created_at DESC,e.id DESC LIMIT 6 OFFSET $3`,
      [owner, reminder ?? null, page * 5],
    );
    const entries = rows.rows.slice(0, 5);
    for (const entry of entries) {
      entry.deliveries = (
        await this.pool.query<HistoryEntry['deliveries'][number]>(
          `SELECT COALESCE(d.target_title,t.title) AS title,d.state,d.last_error_code AS error,
        (SELECT count(*)::int FROM delivery_items WHERE delivery_id=d.id AND state='SENT') AS sent,
        (SELECT count(*)::int FROM delivery_items WHERE delivery_id=d.id) AS total,d.next_attempt_at::text AS "nextAttempt"
        FROM deliveries d JOIN targets t ON t.id=d.target_id WHERE d.execution_id=$1 ORDER BY d.position`,
          [entry.id],
        )
      ).rows;
    }
    return { entries, hasNext: rows.rows.length > 5 };
  }
}
