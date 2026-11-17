ALTER TABLE users ADD COLUMN pstack_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE bot_runs ADD COLUMN usage_notice_tokens integer NOT NULL DEFAULT 0;
ALTER TABLE bot_runs ADD COLUMN usage_notice_calls integer NOT NULL DEFAULT 0;
ALTER TABLE bot_runs ADD COLUMN missing_usage_calls integer NOT NULL DEFAULT 0;
ALTER TABLE agent_tasks ADD COLUMN pause_question text;
