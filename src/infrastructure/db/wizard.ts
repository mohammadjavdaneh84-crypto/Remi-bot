import { randomBytes, randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import type { Pool, PoolClient } from 'pg';
import {
  draftSchema,
  workSchema,
  emptyWork,
  type Session,
  type View,
  type WizardRepository,
  type WizardUnitOfWork,
} from '../../app/wizard/model.js';
import { ruleSchema, validateNewRule } from '../../domain/schedule/rule.js';
import { isDeepStrictEqual } from 'node:util';
import { cancelPending } from './lifecycle.js';
import { nextOccurrence } from '../../domain/schedule/recurrence.js';
import type { Permissions } from '../../domain/target/target.js';
import type { ContentKind } from '../../domain/content/archive.js';

interface Row {
  id: string;
  token: string;
  owner_user_id: string;
  revision: number;
  step: Session['step'];
  status: Session['status'];
  expires_at: Date;
  payload: unknown;
  draft: unknown;
  base_reminder_id: string | null;
  base_version_id: string | null;
}
function session(row: Row): Session {
  return {
    id: row.id,
    token: row.token,
    ownerId: row.owner_user_id,
    revision: row.revision,
    step: row.step,
    status: row.status,
    expiresAt: row.expires_at.toISOString(),
    work: workSchema.parse(row.payload),
    draft: draftSchema.parse(row.draft),
    ...(row.base_reminder_id && row.base_version_id
      ? {
          editing: {
            reminderId: row.base_reminder_id,
            versionId: row.base_version_id,
          },
        }
      : {}),
  };
}
class PgWizardUnit implements WizardUnitOfWork {
  constructor(
    private readonly db: PoolClient,
    private readonly ownerId: string,
    private readonly timezone: string,
  ) {}
  async current(now: string) {
    const expired = await this.db.query<{ id: string }>(
      "UPDATE wizard_sessions SET status='EXPIRED',updated_at=now() WHERE owner_user_id=$1 AND status='ACTIVE' AND expires_at<=$2 RETURNING id",
      [this.ownerId, now],
    );
    for (const row of expired.rows)
      await this.db.query(
        'UPDATE reminder_drafts SET active=false,updated_at=now() WHERE session_id=$1',
        [row.id],
      );
    const result = await this.db.query<Row>(
      "SELECT s.*,d.payload AS draft FROM wizard_sessions s JOIN reminder_drafts d ON d.session_id=s.id WHERE s.owner_user_id=$1 AND s.status='ACTIVE'",
      [this.ownerId],
    );
    return result.rows[0] ? session(result.rows[0]) : null;
  }
  async create(now: string): Promise<Session> {
    const s: Session = {
      id: randomUUID(),
      token: randomBytes(6).toString('base64url'),
      ownerId: this.ownerId,
      revision: 0,
      step: 'NAME',
      status: 'ACTIVE',
      expiresAt: Temporal.Instant.from(now).add({ hours: 24 }).toString(),
      work: emptyWork(),
      draft: {
        name: '',
        timezone: this.timezone,
        archives: [],
        rules: [],
        targets: [],
        pending: [],
      },
    };
    await this.db.query(
      "INSERT INTO wizard_sessions(id,token,owner_user_id,status,step,payload,expires_at) VALUES($1,$2,$3,'ACTIVE',$4,$5,$6)",
      [s.id, s.token, s.ownerId, s.step, JSON.stringify(s.work), s.expiresAt],
    );
    await this.db.query(
      'INSERT INTO reminder_drafts(id,session_id,owner_user_id,payload) VALUES($1,$2,$3,$4)',
      [randomUUID(), s.id, s.ownerId, JSON.stringify(s.draft)],
    );
    return s;
  }
  async save(s: Session) {
    if (s.ownerId !== this.ownerId) throw new Error('Owner mismatch');
    draftSchema.parse(s.draft);
    workSchema.parse(s.work);
    await this.db.query(
      'UPDATE wizard_sessions SET status=$3,step=$4,revision=$5,payload=$6,expires_at=$7,updated_at=now() WHERE id=$1 AND owner_user_id=$2',
      [
        s.id,
        this.ownerId,
        s.status,
        s.step,
        s.revision,
        JSON.stringify(s.work),
        s.expiresAt,
      ],
    );
    await this.db.query(
      'UPDATE reminder_drafts SET payload=$3,active=$4,updated_at=now() WHERE session_id=$1 AND owner_user_id=$2',
      [s.id, this.ownerId, JSON.stringify(s.draft), s.status === 'ACTIVE'],
    );
  }
  async edit(reminderId: string, now: string): Promise<Session> {
    const current = (
      await this.db.query<{
        id: string;
        current_version_id: string;
        name: string;
        timezone: string;
        missed_run_policy: 'LATEST_ONLY' | 'SKIP' | 'CATCH_UP';
      }>(
        `
      SELECT r.id,r.current_version_id,v.name,v.timezone,v.missed_run_policy FROM reminders r JOIN reminder_versions v ON v.id=r.current_version_id
      WHERE r.id=$1 AND r.owner_user_id=$2 AND r.status<>'DELETED' FOR UPDATE OF r`,
        [reminderId, this.ownerId],
      )
    ).rows[0];
    if (!current) throw new Error('Reminder unavailable');
    const s = await this.create(now);
    s.editing = { reminderId, versionId: current.current_version_id };
    s.step = 'PREVIEW';
    s.draft.name = current.name;
    s.draft.timezone = current.timezone;
    s.draft.missedPolicy = current.missed_run_policy;
    const contents = (
      await this.db.query<{ id: string; position: number; kind: ContentKind }>(
        `
      SELECT c.archive_id AS id,c.archive_position AS position,i.content_type AS kind FROM content_items c
      JOIN archived_content_items i ON i.archive_id=c.archive_id AND i.position=c.archive_position
      WHERE c.reminder_version_id=$1 ORDER BY c.position`,
        [current.current_version_id],
      )
    ).rows;
    let previous: (typeof contents)[number] | undefined;
    for (const item of contents) {
      if (previous?.id === item.id && previous.position + 1 === item.position) {
        const last = s.draft.archives.at(-1)!;
        last.count++;
        if (!last.kinds.includes(item.kind)) last.kinds.push(item.kind);
      } else
        s.draft.archives.push({ id: item.id, count: 1, kinds: [item.kind] });
      previous = item;
    }
    s.draft.rules = (
      await this.db.query<Session['draft']['rules'][number]>(
        `SELECT s.id,s.config,s.enabled,c.consumed_count AS "consumedCount"
      FROM schedule_rules s JOIN schedule_cursors c ON c.schedule_rule_id=s.id WHERE s.reminder_version_id=$1 ORDER BY s.position`,
        [current.current_version_id],
      )
    ).rows;
    s.draft.targets = (
      await this.db.query<{ id: string; title: string }>(
        'SELECT t.id,t.title FROM reminder_version_targets vt JOIN targets t ON t.id=vt.target_id WHERE vt.reminder_version_id=$1 ORDER BY vt.position',
        [current.current_version_id],
      )
    ).rows;
    await this.db.query(
      "UPDATE wizard_sessions SET kind='EDIT_REMINDER',base_reminder_id=$2,base_version_id=$3 WHERE id=$1",
      [s.id, reminderId, current.current_version_id],
    );
    await this.save(s);
    return s;
  }
  async commit(s: Session, now: string) {
    const d = draftSchema.parse(s.draft);
    if (
      s.ownerId !== this.ownerId ||
      s.status !== 'ACTIVE' ||
      s.step !== 'PREVIEW' ||
      !d.name.trim() ||
      !d.archives.length ||
      !d.rules.length ||
      !d.targets.length ||
      d.pending.length
    )
      throw new Error('Incomplete draft');
    const locked = await this.db.query(
      "SELECT id FROM wizard_sessions WHERE id=$1 AND owner_user_id=$2 AND status='ACTIVE' AND revision=$3 AND expires_at>$4 FOR UPDATE",
      [s.id, this.ownerId, s.revision, now],
    );
    if (!locked.rowCount) throw new Error('Stale session');
    const stored = (
      await this.db.query<{
        base_reminder_id: string | null;
        base_version_id: string | null;
      }>(
        'SELECT base_reminder_id,base_version_id FROM wizard_sessions WHERE id=$1',
        [s.id],
      )
    ).rows[0]!;
    if (
      stored.base_reminder_id !== (s.editing?.reminderId ?? null) ||
      stored.base_version_id !== (s.editing?.versionId ?? null)
    )
      throw new Error('Invalid edit identity');
    const base = s.editing
      ? (
          await this.db.query<{
            status: string;
            current_version_id: string;
            version_no: number;
          }>(
            `
      SELECT r.status,r.current_version_id,v.version_no FROM reminders r JOIN reminder_versions v ON v.id=r.current_version_id
      WHERE r.id=$1 AND r.owner_user_id=$2 FOR UPDATE OF r`,
            [s.editing.reminderId, this.ownerId],
          )
        ).rows[0]
      : undefined;
    if (
      s.editing &&
      (!base ||
        base.status === 'DELETED' ||
        base.current_version_id !== s.editing.versionId)
    )
      throw new Error('Edit base changed');
    const oldRules = s.editing
      ? (
          await this.db.query<{
            id: string;
            config: unknown;
            consumed_count: number;
            blocked_reason: string | null;
          }>(
            `
      SELECT s.id,s.config,c.consumed_count,c.blocked_reason FROM schedule_rules s JOIN schedule_cursors c ON c.schedule_rule_id=s.id
      WHERE s.reminder_version_id=$1 FOR UPDATE OF c`,
            [s.editing.versionId],
          )
        ).rows
      : [];
    const contents: {
      archiveId: string;
      position: number;
      kind: ContentKind;
    }[] = [];
    for (const ref of d.archives) {
      const result = await this.db.query<{
        position: number;
        content_type: ContentKind;
      }>(
        "SELECT i.position,i.content_type FROM content_archives a JOIN archived_content_items i ON i.archive_id=a.id WHERE a.id=$1 AND a.owner_user_id=$2 AND a.state='READY' ORDER BY i.position",
        [ref.id, this.ownerId],
      );
      if (result.rows.length !== ref.count)
        throw new Error('Invalid content archive');
      for (const row of result.rows)
        contents.push({
          archiveId: ref.id,
          position: row.position,
          kind: row.content_type,
        });
    }
    if (!contents.length || contents.length > 100)
      throw new Error('Invalid content count');
    if (new Set(d.targets.map((t) => t.id)).size !== d.targets.length)
      throw new Error('Duplicate target');
    for (const target of d.targets) {
      const result = await this.db.query<{ permissions: Permissions }>(
        'SELECT permissions FROM targets WHERE id=$1 AND owner_user_id=$2 AND migrated_to_id IS NULL AND is_reachable FOR SHARE',
        [target.id, this.ownerId],
      );
      if (
        !result.rows[0] ||
        contents.some((c) => !result.rows[0]!.permissions.send[c.kind])
      )
        throw new Error('Target permission unavailable');
    }
    const after = Temporal.Instant.from(now)
      .subtract({ nanoseconds: 1 })
      .toString();
    const rules = d.rules.map((r) => {
      const old = oldRules.find(
        (old) =>
          old.id === r.id &&
          isDeepStrictEqual(ruleSchema.parse(old.config), r.config),
      );
      const config = old
        ? ruleSchema.parse(r.config)
        : validateNewRule(r.config, now);
      const count = old?.consumed_count ?? 0;
      const next = nextOccurrence(
        config,
        after,
        {
          timezone: d.timezone,
          calendarSystem: 'gregorian',
        },
        count,
      );
      if (!old && r.enabled !== false && !next)
        throw new Error('Rule has no future occurrence');
      return {
        ...r,
        id: randomUUID(),
        config,
        next,
        count,
        blocked: old?.blocked_reason ?? null,
      };
    });
    const reminderId = s.editing?.reminderId ?? randomUUID(),
      versionId = randomUUID();
    if (!s.editing)
      await this.db.query(
        "INSERT INTO reminders(id,owner_user_id,status) VALUES($1,$2,'PAUSED')",
        [reminderId, this.ownerId],
      );
    await this.db.query(
      'INSERT INTO reminder_versions(id,reminder_id,version_no,name,timezone,missed_run_policy) VALUES($1,$2,$3,$4,$5,$6)',
      [
        versionId,
        reminderId,
        (base?.version_no ?? 0) + 1,
        d.name,
        d.timezone,
        d.missedPolicy ?? 'LATEST_ONLY',
      ],
    );
    for (const [position, c] of contents.entries())
      await this.db.query(
        'INSERT INTO content_items(id,reminder_version_id,position,archive_id,archive_position) VALUES($1,$2,$3,$4,$5)',
        [randomUUID(), versionId, position, c.archiveId, c.position],
      );
    for (const [position, r] of rules.entries()) {
      await this.db.query(
        'INSERT INTO schedule_rules(id,reminder_version_id,position,config,enabled) VALUES($1,$2,$3,$4,$5)',
        [
          r.id,
          versionId,
          position,
          JSON.stringify(r.config),
          r.enabled !== false,
        ],
      );
      await this.db.query(
        'INSERT INTO schedule_cursors(schedule_rule_id,next_due_at,consumed_count,active,blocked_reason) VALUES($1,$2,$3,$4,$5)',
        [
          r.id,
          r.next,
          r.count,
          !!r.next &&
            r.enabled !== false &&
            base?.status !== 'PAUSED' &&
            !r.blocked,
          r.blocked,
        ],
      );
    }
    for (const [position, target] of d.targets.entries())
      await this.db.query(
        'INSERT INTO reminder_version_targets(reminder_version_id,target_id,position) VALUES($1,$2,$3)',
        [versionId, target.id, position],
      );
    if (s.editing) {
      await this.db.query(
        'UPDATE schedule_cursors SET active=false,updated_at=now() WHERE schedule_rule_id IN (SELECT id FROM schedule_rules WHERE reminder_version_id=$1)',
        [s.editing.versionId],
      );
      await cancelPending(this.db, reminderId, 'VERSION_CHANGED');
      await this.db.query(
        'UPDATE reminder_versions SET retired_at=$2,superseded_by_version_id=$3 WHERE id=$1',
        [s.editing.versionId, now, versionId],
      );
    }
    await this.db.query(
      'UPDATE reminder_versions SET activated_at=$2 WHERE id=$1',
      [versionId, now],
    );
    await this.db.query(
      'UPDATE reminders SET status=$3,current_version_id=$2,revision=revision+1,updated_at=now() WHERE id=$1',
      [reminderId, versionId, base?.status ?? 'ACTIVE'],
    );
    s.status = 'COMMITTED';
    s.revision++;
    await this.save(s);
    return reminderId;
  }
}
export class PgWizardRepository implements WizardRepository {
  constructor(private readonly pool: Pool) {}
  async run(
    ownerId: string,
    updateId: number,
    operation: (work: WizardUnitOfWork) => Promise<View | null>,
  ) {
    if (!Number.isSafeInteger(updateId) || updateId < 0)
      throw new Error('Invalid update ID');
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      // NO KEY UPDATE serializes a user's wizard without blocking archive FK inserts on other connections.
      const owner = await db.query<{ default_timezone: string }>(
        'SELECT default_timezone FROM users WHERE id=$1 FOR NO KEY UPDATE',
        [ownerId],
      );
      if (!owner.rows[0]) throw new Error('Unknown owner');
      const receipt = await db.query(
        'INSERT INTO wizard_updates(owner_user_id,update_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING update_id',
        [ownerId, updateId],
      );
      const result = receipt.rowCount
        ? await operation(
            new PgWizardUnit(db, ownerId, owner.rows[0].default_timezone),
          )
        : null;
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
