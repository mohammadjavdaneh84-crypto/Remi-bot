CREATE TABLE daily_header_configs (
  id UUID PRIMARY KEY,
  owner_user_id UUID NOT NULL REFERENCES users(id),
  target_id UUID REFERENCES targets(id),
  telegram_chat_id BIGINT NOT NULL,
  title TEXT NOT NULL,
  timezone TEXT NOT NULL,
  local_time TEXT NOT NULL CHECK (local_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  enabled BOOLEAN NOT NULL DEFAULT true,
  pin_enabled BOOLEAN NOT NULL DEFAULT true,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  next_due_at TIMESTAMPTZ NOT NULL,
  last_pinned_message_id BIGINT,
  last_pinned_chat_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(owner_user_id, telegram_chat_id),
  CHECK ((last_pinned_message_id IS NULL) = (last_pinned_chat_id IS NULL))
);
CREATE INDEX daily_header_due ON daily_header_configs(next_due_at) WHERE enabled;
CREATE TABLE daily_header_runs (
  id UUID PRIMARY KEY,
  config_id UUID NOT NULL REFERENCES daily_header_configs(id),
  local_date DATE NOT NULL,
  timezone TEXT NOT NULL,
  destination_chat_id BIGINT NOT NULL,
  pin_enabled BOOLEAN NOT NULL,
  stage TEXT NOT NULL DEFAULT 'SEND' CHECK (stage IN ('SEND','SENDING','PIN','UNPIN','DONE')),
  state TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','SUCCEEDED','FAILED','UNKNOWN','CANCELLED')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL,
  message_id BIGINT,
  previous_message_id BIGINT,
  previous_chat_id BIGINT,
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(config_id, local_date),
  CHECK ((previous_message_id IS NULL) = (previous_chat_id IS NULL))
);
CREATE INDEX daily_header_retry ON daily_header_runs(next_attempt_at) WHERE state='ACTIVE';
CREATE TABLE daily_header_drafts (
  owner_user_id UUID PRIMARY KEY REFERENCES users(id),
  token UUID NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  payload JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE daily_header_updates (
  owner_user_id UUID NOT NULL REFERENCES users(id),
  update_id BIGINT NOT NULL,
  PRIMARY KEY(owner_user_id, update_id)
);
