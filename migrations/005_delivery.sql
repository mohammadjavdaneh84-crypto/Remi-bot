ALTER TABLE deliveries ADD COLUMN resolved_target_id UUID REFERENCES targets(id);
ALTER TABLE deliveries ADD COLUMN destination_chat_id BIGINT;
ALTER TABLE deliveries ADD COLUMN target_title TEXT;
CREATE TABLE delivery_items (
  id UUID PRIMARY KEY, delivery_id UUID NOT NULL REFERENCES deliveries(id),
  sequence INTEGER NOT NULL CHECK(sequence>=0), storage_chat_id BIGINT NOT NULL,
  storage_message_ids JSONB NOT NULL, content_kinds JSONB NOT NULL,
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','SENDING','SENT','FAILED_RETRYABLE','FAILED_PERMANENT','UNKNOWN')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
  destination_chat_id BIGINT, sent_message_ids JSONB NOT NULL DEFAULT '[]',
  last_error_code TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(delivery_id,sequence), UNIQUE(delivery_id,id)
);
CREATE TABLE delivery_item_contents (
  delivery_id UUID NOT NULL, delivery_item_id UUID NOT NULL,
  content_item_id UUID NOT NULL REFERENCES content_items(id), position INTEGER NOT NULL CHECK(position>=0),
  PRIMARY KEY(delivery_id,content_item_id), UNIQUE(delivery_item_id,position),
  FOREIGN KEY(delivery_id,delivery_item_id) REFERENCES delivery_items(delivery_id,id)
);
CREATE INDEX recoverable_deliveries ON deliveries(created_at,id) WHERE state='PROCESSING';
CREATE INDEX target_delivery_queue ON deliveries(target_id,execution_id) WHERE state IN ('PENDING','PROCESSING','FAILED_RETRYABLE');
CREATE INDEX execution_history ON executions(reminder_id,scheduled_for DESC,id);
