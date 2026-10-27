ALTER TABLE bot_messages ADD COLUMN reply_segments jsonb NOT NULL DEFAULT '[]';
ALTER TABLE bot_runs ADD COLUMN first_reply_generated_at timestamptz;
ALTER TABLE bot_runs ADD COLUMN first_reply_at timestamptz;
ALTER TABLE bot_runs ADD COLUMN first_reply_generation_ms double precision;

CREATE TABLE agent_task_messages (
  seq bigserial PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES agent_tasks(task_id) ON DELETE CASCADE,
  event_key text NOT NULL,
  from_bot_id uuid NOT NULL REFERENCES bots(bot_id) ON DELETE CASCADE,
  to_bot_id uuid NOT NULL REFERENCES bots(bot_id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('request','instruction','opening','update','answer','error')),
  content text NOT NULL,
  created_at timestamptz,
  UNIQUE(task_id,event_key)
);
CREATE INDEX agent_task_messages_page ON agent_task_messages(task_id,seq);

-- Reconstruct only information and timestamps actually retained by older versions.
INSERT INTO agent_task_messages(task_id,event_key,from_bot_id,to_bot_id,kind,content,created_at)
SELECT task_id,'request',parent_bot_id,target_bot_id,'request',task,created_at FROM agent_tasks WHERE kind='delegation';
INSERT INTO agent_task_messages(task_id,event_key,from_bot_id,to_bot_id,kind,content,created_at)
SELECT t.task_id,'instruction:'||i.request_id,t.parent_bot_id,t.target_bot_id,'instruction',i.text,i.created_at
FROM agent_task_instructions i JOIN agent_tasks t USING(task_id) WHERE t.kind='delegation';
INSERT INTO agent_task_messages(task_id,event_key,from_bot_id,to_bot_id,kind,content,created_at)
SELECT t.task_id,'progress:'||r.run_id||':'||(p.ordinality-1),t.target_bot_id,t.parent_bot_id,'update',p.content,NULL
FROM agent_tasks t JOIN bot_runs r ON r.run_id=t.child_run_id JOIN bot_messages m ON m.message_id=r.assistant_message_id
CROSS JOIN LATERAL jsonb_array_elements_text(m.progress) WITH ORDINALITY AS p(content,ordinality)
WHERE t.kind='delegation' AND p.content<>'';
INSERT INTO agent_task_messages(task_id,event_key,from_bot_id,to_bot_id,kind,content,created_at)
SELECT task_id,'terminal',target_bot_id,parent_bot_id,CASE WHEN status='completed' THEN 'answer' ELSE 'error' END,
  CASE WHEN status='completed' THEN result ELSE coalesce(error,CASE WHEN status='cancelled' THEN '任务已取消' ELSE '任务未完成' END) END,finished_at
FROM agent_tasks WHERE kind='delegation' AND status IN ('completed','failed','cancelled')
  AND (status<>'completed' OR coalesce(result,'')<>'');
