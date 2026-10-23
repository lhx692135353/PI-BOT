ALTER TABLE bot_runs DROP CONSTRAINT bot_runs_origin_check;
ALTER TABLE bot_runs ADD CONSTRAINT bot_runs_origin_check
  CHECK (origin IN ('user', 'agent', 'report', 'automation', 'voice'));
