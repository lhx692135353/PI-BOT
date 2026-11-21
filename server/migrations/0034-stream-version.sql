ALTER TABLE bot_messages ADD COLUMN stream_seq bigint NOT NULL DEFAULT 0;
CREATE FUNCTION bump_message_stream() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.content IS DISTINCT FROM OLD.content OR NEW.status IS DISTINCT FROM OLD.status
   OR NEW.progress IS DISTINCT FROM OLD.progress OR NEW.reply_segments IS DISTINCT FROM OLD.reply_segments
   OR NEW.visibility IS DISTINCT FROM OLD.visibility THEN
   NEW.stream_seq=OLD.stream_seq+1;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER message_stream_version BEFORE UPDATE ON bot_messages FOR EACH ROW EXECUTE FUNCTION bump_message_stream();
