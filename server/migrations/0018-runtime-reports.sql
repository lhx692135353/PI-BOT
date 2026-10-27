ALTER TABLE models ADD COLUMN capabilities jsonb NOT NULL DEFAULT '{"chat":true,"vision":true,"voice":false,"tools":true,"reasoning":"unknown"}';
CREATE TABLE report_artifacts (
 artifact_id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
 bot_id uuid NOT NULL REFERENCES bots(bot_id) ON DELETE CASCADE, run_id uuid NOT NULL REFERENCES bot_runs(run_id) ON DELETE CASCADE,
 call_id text NOT NULL, title text NOT NULL, name text NOT NULL, mime text NOT NULL DEFAULT 'text/markdown',
 size integer NOT NULL CHECK(size>0 AND size<=10485760), body bytea NOT NULL, summary text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(run_id,call_id)
);
CREATE TABLE message_artifacts (
 message_id uuid NOT NULL REFERENCES bot_messages(message_id) ON DELETE CASCADE,
 artifact_id uuid NOT NULL REFERENCES report_artifacts(artifact_id) ON DELETE CASCADE,
 PRIMARY KEY(message_id,artifact_id)
);
CREATE TABLE action_receipts (
 run_id uuid NOT NULL REFERENCES bot_runs(run_id) ON DELETE CASCADE, call_id text NOT NULL,
 tool text NOT NULL, status text NOT NULL, resource_id text, target_id text, error_info jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(run_id,call_id)
);
ALTER TABLE bot_runs ADD COLUMN tool_manifest jsonb NOT NULL DEFAULT '[]';
ALTER TABLE bot_runs ADD COLUMN error_info jsonb;
