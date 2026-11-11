ALTER TABLE bots ADD COLUMN runtime text NOT NULL DEFAULT 'pi';
ALTER TABLE bots ADD CONSTRAINT bots_runtime_check CHECK (runtime IN ('pi', 'cursor', 'codex'));
ALTER TABLE bots ADD COLUMN cli_profile text;
ALTER TABLE bots ADD COLUMN cli_directory text;
ALTER TABLE bots ADD COLUMN cli_device_id uuid REFERENCES devices(device_id);

CREATE TABLE cli_sessions (
  session_id uuid PRIMARY KEY,
  bot_id uuid NOT NULL REFERENCES bots(bot_id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(device_id),
  engine_session_id text NOT NULL,
  title text NOT NULL DEFAULT '',
  summary text NOT NULL DEFAULT '',
  last_user_text text NOT NULL DEFAULT '',
  origin text NOT NULL CHECK (origin IN ('user', 'delegation')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cli_sessions_bot_open ON cli_sessions(bot_id, updated_at DESC) WHERE status = 'open';
