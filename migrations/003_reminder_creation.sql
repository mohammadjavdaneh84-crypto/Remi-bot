CREATE TABLE wizard_sessions (
  id UUID PRIMARY KEY, token TEXT NOT NULL UNIQUE,
  owner_user_id UUID NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL DEFAULT 'CREATE_REMINDER' CHECK(kind='CREATE_REMINDER'),
  status TEXT NOT NULL CHECK(status IN ('ACTIVE','CANCELLED','EXPIRED','COMMITTED')),
  step TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
  payload JSONB NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_active_wizard ON wizard_sessions(owner_user_id) WHERE status='ACTIVE';
CREATE TABLE reminder_drafts (
  id UUID PRIMARY KEY, session_id UUID NOT NULL UNIQUE REFERENCES wizard_sessions(id),
  owner_user_id UUID NOT NULL REFERENCES users(id),
  active BOOLEAN NOT NULL DEFAULT true, payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE wizard_updates (
  owner_user_id UUID NOT NULL REFERENCES users(id), update_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(owner_user_id,update_id)
);
CREATE TABLE reminders (
  id UUID PRIMARY KEY, owner_user_id UUID NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK(status IN ('ACTIVE','PAUSED','DELETED')),
  current_version_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paused_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ,
  CHECK(status <> 'ACTIVE' OR current_version_id IS NOT NULL)
);
CREATE INDEX reminders_owner_status ON reminders(owner_user_id,status);
CREATE TABLE reminder_versions (
  id UUID PRIMARY KEY, reminder_id UUID NOT NULL REFERENCES reminders(id),
  version_no INTEGER NOT NULL CHECK(version_no>0), name TEXT NOT NULL,
  timezone TEXT NOT NULL, calendar_system TEXT NOT NULL DEFAULT 'gregorian' CHECK(calendar_system='gregorian'),
  missed_run_policy TEXT NOT NULL DEFAULT 'LATEST_ONLY' CHECK(missed_run_policy IN ('LATEST_ONLY','SKIP','CATCH_UP')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), activated_at TIMESTAMPTZ, retired_at TIMESTAMPTZ,
  superseded_by_version_id UUID REFERENCES reminder_versions(id),
  UNIQUE(reminder_id,version_no), UNIQUE(reminder_id,id)
);
CREATE UNIQUE INDEX one_active_version ON reminder_versions(reminder_id) WHERE activated_at IS NOT NULL AND retired_at IS NULL;
ALTER TABLE reminders ADD CONSTRAINT current_version_belongs_to_reminder FOREIGN KEY(id,current_version_id) REFERENCES reminder_versions(reminder_id,id);
CREATE TABLE content_items (
  id UUID PRIMARY KEY, reminder_version_id UUID NOT NULL REFERENCES reminder_versions(id),
  position INTEGER NOT NULL CHECK(position>=0), archive_id UUID NOT NULL, archive_position INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(reminder_version_id,position),
  FOREIGN KEY(archive_id,archive_position) REFERENCES archived_content_items(archive_id,position)
);
CREATE TABLE schedule_rules (
  id UUID PRIMARY KEY, reminder_version_id UUID NOT NULL REFERENCES reminder_versions(id),
  position INTEGER NOT NULL CHECK(position>=0), config JSONB NOT NULL, enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(reminder_version_id,position)
);
CREATE TABLE reminder_version_targets (
  reminder_version_id UUID NOT NULL REFERENCES reminder_versions(id), target_id UUID NOT NULL REFERENCES targets(id),
  position INTEGER NOT NULL CHECK(position>=0), PRIMARY KEY(reminder_version_id,target_id), UNIQUE(reminder_version_id,position)
);
CREATE TABLE schedule_cursors (
  schedule_rule_id UUID PRIMARY KEY REFERENCES schedule_rules(id), next_due_at TIMESTAMPTZ,
  last_due_at TIMESTAMPTZ, consumed_count INTEGER NOT NULL DEFAULT 0 CHECK(consumed_count>=0),
  active BOOLEAN NOT NULL DEFAULT true, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX due_schedule_cursors ON schedule_cursors(next_due_at) WHERE active;

-- Definitions are editable only while assembling a not-yet-activated version.
CREATE FUNCTION protect_version_definition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.activated_at IS NOT NULL AND
    (TG_OP='DELETE' OR (to_jsonb(NEW) - ARRAY['retired_at','superseded_by_version_id']) IS DISTINCT FROM
                       (to_jsonb(OLD) - ARRAY['retired_at','superseded_by_version_id'])) THEN
    RAISE EXCEPTION 'Activated version definitions are immutable';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_version BEFORE UPDATE OR DELETE ON reminder_versions FOR EACH ROW EXECUTE FUNCTION protect_version_definition();
CREATE FUNCTION protect_version_child() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' AND EXISTS(SELECT 1 FROM reminder_versions WHERE id=OLD.reminder_version_id AND activated_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Activated version children are immutable';
  END IF;
  IF TG_OP <> 'DELETE' AND EXISTS(SELECT 1 FROM reminder_versions WHERE id=NEW.reminder_version_id AND activated_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Activated version children are immutable';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_content BEFORE INSERT OR UPDATE OR DELETE ON content_items FOR EACH ROW EXECUTE FUNCTION protect_version_child();
CREATE TRIGGER immutable_rule BEFORE INSERT OR UPDATE OR DELETE ON schedule_rules FOR EACH ROW EXECUTE FUNCTION protect_version_child();
CREATE TRIGGER immutable_targets BEFORE INSERT OR UPDATE OR DELETE ON reminder_version_targets FOR EACH ROW EXECUTE FUNCTION protect_version_child();
