ALTER TABLE schedule_cursors ADD COLUMN blocked_reason TEXT CHECK(blocked_reason IN ('CATCH_UP_LIMIT'));
ALTER TABLE schedule_cursors ADD CONSTRAINT blocked_cursor_inactive CHECK(blocked_reason IS NULL OR NOT active);
ALTER TABLE schedule_rules ADD CONSTRAINT rule_version_identity UNIQUE(reminder_version_id,id);

CREATE TABLE executions (
  id UUID PRIMARY KEY, reminder_id UUID NOT NULL REFERENCES reminders(id),
  reminder_version_id UUID NOT NULL, scheduled_for TIMESTAMPTZ NOT NULL,
  trigger_kind TEXT NOT NULL CHECK(trigger_kind IN ('SCHEDULED','MANUAL')),
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','PROCESSING','SUCCEEDED','PARTIAL_FAILED','FAILED','CANCELLED')),
  dedupe_key TEXT NOT NULL UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, cancel_reason TEXT,
  FOREIGN KEY(reminder_id,reminder_version_id) REFERENCES reminder_versions(reminder_id,id),
  UNIQUE(reminder_version_id,id)
);
CREATE UNIQUE INDEX scheduled_execution_once ON executions(reminder_version_id,scheduled_for) WHERE trigger_kind='SCHEDULED';
CREATE INDEX pending_executions ON executions(scheduled_for,id) WHERE state='PENDING';
CREATE TABLE execution_rules (
  execution_id UUID NOT NULL, schedule_rule_id UUID NOT NULL, reminder_version_id UUID NOT NULL,
  PRIMARY KEY(execution_id,schedule_rule_id),
  FOREIGN KEY(reminder_version_id,execution_id) REFERENCES executions(reminder_version_id,id),
  FOREIGN KEY(reminder_version_id,schedule_rule_id) REFERENCES schedule_rules(reminder_version_id,id)
);
CREATE TABLE deliveries (
  id UUID PRIMARY KEY, execution_id UUID NOT NULL REFERENCES executions(id),
  target_id UUID NOT NULL REFERENCES targets(id), position INTEGER NOT NULL CHECK(position>=0),
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','PROCESSING','SUCCEEDED','FAILED_RETRYABLE','FAILED_PERMANENT','UNKNOWN','CANCELLED')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0), next_attempt_at TIMESTAMPTZ,
  last_error_code TEXT, last_error_message TEXT, started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(execution_id,target_id), UNIQUE(execution_id,position)
);
CREATE INDEX claimable_deliveries ON deliveries(next_attempt_at,created_at) WHERE state IN ('PENDING','FAILED_RETRYABLE');
