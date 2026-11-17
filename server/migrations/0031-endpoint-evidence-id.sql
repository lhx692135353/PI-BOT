ALTER TABLE endpoint_experiences ADD COLUMN tool_call_id text;
CREATE UNIQUE INDEX endpoint_evidence_call ON endpoint_experiences(run_id,tool_call_id);
ALTER TABLE bot_runs ADD COLUMN endpoint_observations jsonb NOT NULL DEFAULT '[]';
