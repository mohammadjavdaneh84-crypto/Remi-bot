CREATE TABLE users (
  id UUID PRIMARY KEY,
  telegram_user_id BIGINT UNIQUE NOT NULL CHECK (telegram_user_id > 0),
  default_timezone TEXT NOT NULL,
  locale TEXT NOT NULL DEFAULT 'fa',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
