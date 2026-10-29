-- Strategies belong to tasks/goals; actual run targets remain historical facts.
ALTER TABLE bot_runs ADD COLUMN routing jsonb;
ALTER TABLE agent_tasks ADD COLUMN routing jsonb;
ALTER TABLE bot_goals ADD COLUMN routing jsonb;
ALTER TABLE bot_goals ADD COLUMN checkpoint_target text;
ALTER TABLE bot_automations ADD COLUMN checkpoint_target text;
ALTER TABLE bot_automations ADD COLUMN routing jsonb;
-- Preserve old task destinations, including work already queued.
-- Existing goal groups keep their keys so in-flight rounds and reports stay valid.
UPDATE bot_goals g SET routing=jsonb_build_object(
 'execution','auto','preferred_device_id',CASE WHEN g.operation_target LIKE 'device:%' THEN split_part(g.operation_target,':',2) ELSE NULL END,
 'requirements','["files","shell"]'::jsonb,
 'resources',CASE WHEN g.checkpoint<>'{}'::jsonb AND g.operation_target ~ '^(device|remote):' THEN jsonb_build_array(jsonb_build_object('target',g.operation_target)) ELSE '[]'::jsonb END);
UPDATE bot_automations a SET routing=coalesce(
 (SELECT g.routing FROM bot_goals g WHERE g.bot_id=a.bot_id AND g.operation_target=a.operation_target ORDER BY (g.checkpoint<>'{}'::jsonb) DESC,g.created_at LIMIT 1),
 jsonb_build_object('execution','auto','requirements','["files","shell"]'::jsonb,'resources','[]'::jsonb));
UPDATE bot_goals g SET routing=jsonb_set(g.routing,'{resources}',jsonb_build_array(jsonb_build_object('target',g.operation_target)))
 WHERE g.operation_target ~ '^(device|remote):' AND EXISTS (SELECT 1 FROM bot_automations a WHERE a.bot_id=g.bot_id AND a.operation_target=g.operation_target AND a.checkpoint<>'{}'::jsonb);
UPDATE bot_automations a SET routing=jsonb_set(a.routing,'{resources}',jsonb_build_array(jsonb_build_object('target',a.operation_target)))
 WHERE a.operation_target ~ '^(device|remote):' AND a.checkpoint<>'{}'::jsonb;
UPDATE bot_goals SET checkpoint_target=operation_target WHERE checkpoint<>'{}'::jsonb;
UPDATE bot_automations SET checkpoint_target=operation_target WHERE checkpoint<>'{}'::jsonb;
-- Retain the deprecated column for old clients and migration audit; runtime ignores it.
