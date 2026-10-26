CREATE TABLE remote_environments (
 environment_id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
 backend text NOT NULL CHECK (backend IN ('ssh','kubevirt')), revision integer NOT NULL DEFAULT 1,
 config jsonb NOT NULL DEFAULT '{}', secret jsonb NOT NULL,
 status text NOT NULL DEFAULT 'unconfigured', error text, capabilities jsonb NOT NULL DEFAULT '[]',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX remote_environments_one_active ON remote_environments(user_id) WHERE status<>'retired';
ALTER TABLE bot_runs ADD COLUMN operation_target text NOT NULL DEFAULT 'legacy';
ALTER TABLE bot_runs ADD COLUMN source_device_id uuid;
ALTER TABLE bot_runs ADD COLUMN source_client text NOT NULL DEFAULT 'legacy';
ALTER TABLE agent_tasks DROP CONSTRAINT agent_tasks_execution_check;
ALTER TABLE agent_tasks ADD CONSTRAINT agent_tasks_execution_check CHECK (execution IN ('device','cloud','remote'));
ALTER TABLE agent_tasks ADD COLUMN operation_target text NOT NULL DEFAULT 'legacy';
ALTER TABLE bot_goals ADD COLUMN operation_target text NOT NULL DEFAULT 'unassigned';
ALTER TABLE bot_automations ADD COLUMN operation_target text NOT NULL DEFAULT 'unassigned';
UPDATE bot_goals g SET operation_target='device:' || b.execution_device_id FROM bots b WHERE g.bot_id=b.bot_id AND b.execution_device_id IS NOT NULL;
UPDATE bot_automations a SET operation_target='device:' || b.execution_device_id FROM bots b WHERE a.bot_id=b.bot_id AND b.execution_device_id IS NOT NULL;
DROP INDEX bot_automations_review;
CREATE UNIQUE INDEX bot_automations_review ON bot_automations(bot_id,operation_target) WHERE kind='review';
CREATE TABLE remote_operations (
 run_id uuid NOT NULL REFERENCES bot_runs(run_id) ON DELETE CASCADE, call_id text NOT NULL,
 action text NOT NULL, status text NOT NULL DEFAULT 'started', result jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(run_id,call_id)
);
CREATE TABLE remote_artifacts (
 artifact_id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
 bot_id uuid NOT NULL REFERENCES bots(bot_id) ON DELETE CASCADE, environment_id uuid NOT NULL,
 path text NOT NULL, name text NOT NULL, mime text NOT NULL DEFAULT 'application/octet-stream',
 created_at timestamptz NOT NULL DEFAULT now()
);
