ALTER TABLE bot_runs ADD COLUMN expected_output text CHECK (expected_output IS NULL OR expected_output='image');
ALTER TABLE bot_runs ADD COLUMN image_refs jsonb NOT NULL DEFAULT '[]';
ALTER TABLE agent_tasks ADD COLUMN expected_output text CHECK (expected_output IS NULL OR expected_output='image');
ALTER TABLE agent_tasks ADD COLUMN image_refs jsonb NOT NULL DEFAULT '[]';
ALTER TABLE image_generation_jobs ADD COLUMN operation text NOT NULL DEFAULT 'generate';
ALTER TABLE image_generation_jobs ADD COLUMN source_refs jsonb NOT NULL DEFAULT '[]';
ALTER TABLE report_artifacts ADD COLUMN image_metadata jsonb;
