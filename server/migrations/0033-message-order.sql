-- Conversation ordering is independent of execution/maintenance activity.
ALTER TABLE bots ADD COLUMN last_message_at timestamptz NOT NULL DEFAULT now();
UPDATE bots b SET last_message_at=coalesce((
  SELECT max(CASE WHEN m.role='assistant' THEN m.updated_at ELSE m.created_at END)
  FROM bot_messages m WHERE m.bot_id=b.bot_id AND m.visibility='public'
    AND (m.role='user' OR m.status IN ('completed','failed'))
),b.created_at);
CREATE INDEX bots_message_order ON bots(user_id,is_main DESC,last_message_at DESC,bot_id) WHERE archived_at IS NULL;

CREATE TABLE bot_reads (
  user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  bot_id uuid NOT NULL REFERENCES bots(bot_id) ON DELETE CASCADE,
  last_read_seq bigint NOT NULL DEFAULT 0 CHECK (last_read_seq>=0),
  PRIMARY KEY(user_id,bot_id)
);
CREATE INDEX bot_messages_unread ON bot_messages(bot_id,seq) WHERE visibility='public' AND role='assistant' AND status='completed';

-- Centralize the rule so voice transcripts and future public-message entrypoints
-- follow exactly the same semantics. Streaming/progress updates never reorder.
CREATE FUNCTION advance_bot_message_time() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.visibility='public' AND (
    (NEW.role='user' AND TG_OP='INSERT') OR
    (NEW.role='assistant' AND NEW.status IN ('completed','failed') AND
      (TG_OP='INSERT' OR OLD.status='running' OR OLD.visibility<>'public'))
  ) THEN
    UPDATE bots SET last_message_at=greatest(last_message_at,
      CASE WHEN NEW.role='user' THEN NEW.created_at ELSE NEW.updated_at END)
      WHERE bot_id=NEW.bot_id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER bot_message_order AFTER INSERT OR UPDATE ON bot_messages
  FOR EACH ROW EXECUTE FUNCTION advance_bot_message_time();
