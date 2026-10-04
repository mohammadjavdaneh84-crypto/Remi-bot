import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Rule } from '../../src/domain/schedule/rule.js';
import { nextOccurrence } from '../../src/domain/schedule/recurrence.js';
import { PgTargetRepository } from '../../src/infrastructure/db/targets.js';
import { snapshot } from './phase2.js';
export const managementNow = '2026-10-03T12:00:10Z';
export const countedDaily: Extract<Rule, { type: 'EVERY_N_DAYS' }> = {
  type: 'EVERY_N_DAYS',
  every: 1,
  anchorDate: '2026-10-01',
  localTime: '12:00',
  end: { type: 'AFTER_N_EXECUTIONS', count: 3 },
};
export async function seedManaged(
  pool: Pool,
  owner: string,
  rules: Rule[] = [countedDaily],
) {
  const id = randomUUID(),
    version = randomUUID();
  await pool.query(
    "INSERT INTO reminders(id,owner_user_id,status) VALUES($1,$2,'PAUSED')",
    [id, owner],
  );
  await pool.query(
    "INSERT INTO reminder_versions(id,reminder_id,version_no,name,timezone,missed_run_policy) VALUES($1,$2,1,'مدیریت','UTC','CATCH_UP')",
    [version, id],
  );
  const archives: string[] = [];
  for (let i = 0; i < 2; i++) {
    const archive = randomUUID();
    archives.push(archive);
    await pool.query(
      "INSERT INTO content_archives(id,owner_user_id,source_key,source_chat_id,storage_chat_id,state) VALUES($1,$2,$3,123,-1001,'READY')",
      [archive, owner, archive],
    );
    await pool.query(
      "INSERT INTO archived_content_items(archive_id,position,source_message_id,storage_message_id,content_type,metadata) VALUES($1,0,$2,$3,'text','{}')",
      [archive, i + 1, 101 + i],
    );
    await pool.query(
      'INSERT INTO content_items(id,reminder_version_id,position,archive_id,archive_position) VALUES($1,$2,$3,$4,0)',
      [randomUUID(), version, i, archive],
    );
  }
  const ruleIds: string[] = [];
  for (const [position, config] of rules.entries()) {
    const rule = randomUUID();
    ruleIds.push(rule);
    await pool.query(
      'INSERT INTO schedule_rules(id,reminder_version_id,position,config) VALUES($1,$2,$3,$4)',
      [rule, version, position, config],
    );
    await pool.query(
      'INSERT INTO schedule_cursors(schedule_rule_id,next_due_at) VALUES($1,$2)',
      [
        rule,
        nextOccurrence(config, '2026-10-02T23:59:59Z', {
          timezone: 'UTC',
          calendarSystem: 'gregorian',
        }),
      ],
    );
  }
  const target = await new PgTargetRepository(pool).save(owner, {
    ...snapshot,
    chatId: '-2001',
    title: 'مقصد',
  });
  await pool.query(
    'INSERT INTO reminder_version_targets(reminder_version_id,target_id,position) VALUES($1,$2,0)',
    [version, target.id],
  );
  await pool.query(
    "UPDATE reminder_versions SET activated_at='2026-10-01T00:00:00Z' WHERE id=$1",
    [version],
  );
  await pool.query(
    "UPDATE reminders SET status='ACTIVE',current_version_id=$2 WHERE id=$1",
    [id, version],
  );
  return { id, version, archives, ruleIds, target };
}
