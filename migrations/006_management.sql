ALTER TABLE reminders ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0);
ALTER TABLE wizard_sessions DROP CONSTRAINT wizard_sessions_kind_check;
ALTER TABLE wizard_sessions ADD CONSTRAINT wizard_sessions_kind_check CHECK(kind IN ('CREATE_REMINDER','EDIT_REMINDER'));
ALTER TABLE wizard_sessions ADD COLUMN base_reminder_id UUID REFERENCES reminders(id);
ALTER TABLE wizard_sessions ADD COLUMN base_version_id UUID;
ALTER TABLE wizard_sessions ADD CONSTRAINT edit_base_version FOREIGN KEY(base_reminder_id,base_version_id) REFERENCES reminder_versions(reminder_id,id);
ALTER TABLE wizard_sessions ADD CONSTRAINT edit_base_required CHECK(
  (kind='CREATE_REMINDER' AND base_reminder_id IS NULL AND base_version_id IS NULL) OR
  (kind='EDIT_REMINDER' AND base_reminder_id IS NOT NULL AND base_version_id IS NOT NULL));
CREATE TABLE management_updates (
  owner_user_id UUID NOT NULL REFERENCES users(id), update_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(owner_user_id,update_id)
);
