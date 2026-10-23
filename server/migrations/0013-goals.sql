-- Goals replace patrols and commissions. One review loop per bot runs only while a goal is active.
CREATE TABLE bot_goals (
  goal_id uuid PRIMARY KEY,
  bot_id uuid NOT NULL REFERENCES bots(bot_id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  title text NOT NULL,
  statement text NOT NULL,
  authorization_scope text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','waiting_user','done','stopped')),
  progress text,
  checkpoint jsonb NOT NULL DEFAULT '{}',
  checkpoint_version integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1,
  source_run_id uuid REFERENCES bot_runs(run_id) ON DELETE SET NULL,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_run_id, request_id)
);
CREATE INDEX bot_goals_bot ON bot_goals(bot_id, created_at);

INSERT INTO bot_goals(goal_id,bot_id,user_id,title,statement,authorization_scope,status,progress,checkpoint,checkpoint_version,version,source_run_id,request_id,created_at,updated_at)
SELECT automation_id,bot_id,user_id,title,goal,authorization_scope,
  CASE status
    WHEN 'paused' THEN 'paused'
    WHEN 'waiting_user' THEN 'waiting_user'
    WHEN 'completed' THEN 'done'
    WHEN 'stopped' THEN 'stopped'
    ELSE 'active'
  END,
  last_result,checkpoint,checkpoint_version,version,source_run_id,request_id,created_at,updated_at
FROM bot_automations WHERE kind='commission';

UPDATE bot_runs SET cancel_requested=true
WHERE automation_id IS NOT NULL AND status IN ('queued','running','waiting_approval');

-- Drop patrols and the old per-item schedules. Chat messages already delivered stay on bot_messages.
DELETE FROM bot_automations;

ALTER TABLE bot_automations DROP CONSTRAINT bot_automations_kind_check;
ALTER TABLE bot_automations ADD CONSTRAINT bot_automations_kind_check CHECK (kind IN ('review'));
DROP INDEX bot_automations_patrol;
CREATE UNIQUE INDEX bot_automations_review ON bot_automations(bot_id) WHERE kind='review';

ALTER TABLE automation_reports ADD COLUMN goal_id uuid REFERENCES bot_goals(goal_id) ON DELETE SET NULL;

INSERT INTO bot_automations(automation_id,bot_id,user_id,kind,title,goal,schedule,status,next_wake_at)
SELECT gen_random_uuid(),bot_id,user_id,'review','目标检查',
  '对照进行中的目标与当前状态，只推进已授权且有明确下一步的事项。',
  '{"type":"adaptive"}','enabled',now()+interval '1 hour'
FROM (SELECT DISTINCT bot_id,user_id FROM bot_goals WHERE status='active') goals;
