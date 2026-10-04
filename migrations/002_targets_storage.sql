DO $$ BEGIN
  IF current_setting('server_encoding') <> 'UTF8' THEN
    RAISE EXCEPTION 'Remi requires a UTF8 database for Persian content';
  END IF;
END $$;

CREATE TABLE targets (
  id UUID PRIMARY KEY,
  owner_user_id UUID NOT NULL REFERENCES users(id),
  telegram_chat_id BIGINT NOT NULL CHECK (telegram_chat_id < 0),
  chat_type TEXT NOT NULL CHECK (chat_type IN ('group', 'supergroup', 'channel')),
  title TEXT NOT NULL,
  username TEXT,
  membership_status TEXT NOT NULL,
  permissions JSONB NOT NULL,
  is_reachable BOOLEAN NOT NULL,
  migrated_to_id UUID REFERENCES targets(id),
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(owner_user_id, telegram_chat_id),
  CHECK (migrated_to_id IS NULL OR migrated_to_id <> id)
);
CREATE INDEX targets_owner_list ON targets(owner_user_id, discovered_at, id) WHERE migrated_to_id IS NULL;

CREATE TABLE content_archives (
  id UUID PRIMARY KEY,
  owner_user_id UUID NOT NULL REFERENCES users(id),
  source_key TEXT NOT NULL,
  source_chat_id BIGINT NOT NULL CHECK (source_chat_id > 0),
  storage_chat_id BIGINT NOT NULL CHECK (storage_chat_id < 0),
  state TEXT NOT NULL CHECK (state IN ('COPYING', 'READY', 'REJECTED', 'UNKNOWN')),
  error_code TEXT,
  copied_message_ids JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(owner_user_id, source_key)
);
CREATE TABLE archived_content_items (
  archive_id UUID NOT NULL REFERENCES content_archives(id),
  position INTEGER NOT NULL CHECK (position >= 0),
  source_message_id BIGINT NOT NULL CHECK (source_message_id > 0),
  storage_message_id BIGINT NOT NULL CHECK (storage_message_id > 0),
  content_type TEXT NOT NULL CHECK (content_type IN ('text','photo','video','animation','document','audio','voice','video_note','sticker')),
  telegram_file_id TEXT,
  telegram_file_unique_id TEXT,
  media_group_key TEXT,
  metadata JSONB NOT NULL,
  PRIMARY KEY(archive_id, position),
  UNIQUE(archive_id, storage_message_id)
);
