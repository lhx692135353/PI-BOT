import { randomUUID } from 'node:crypto';
import { fail, type Row, type Tx } from './db.js';

const capabilityFor = (name: string) => ({web_search:'search',composio_execute:'connector',run_command:'shell',bash:'shell',shell:'shell',read_file:'files',write_file:'files',edit_file:'files',list_files:'files',search_files:'files',file_bytes:'files',file_fetch:'files',document_read:'files',document_write:'files',document_edit:'files',electron_test:'desktop',read:'files',write:'files',edit:'files',ls:'files',find:'files',grep:'files',browser:'browser',browser_test:'browser',desktop:'desktop'} as Record<string,string>)[name];
/** Append observations; contradictory evidence never erases earlier observations. */
export async function recordEndpointExperience(tx: Tx, run: Row, tools: Row[]) {
  if (run.lane !== 'task' || ! /^(cloud|(device|remote):[0-9a-f-]{36})$/.test(run.operation_target ?? '')) return;
  for (const tool of tools) {
    const capability = capabilityFor(tool.name);
    if (!capability || !['completed','failed'].includes(tool.state)) continue;
    // Paths come only from completed file operations, never requested routing paths or tool manifests.
    const path = capability === 'files' && typeof tool.observed_path === 'string' ? tool.observed_path : null;
    const data = {
      evidence_id:randomUUID(),bot_id:run.bot_id,run_id:run.run_id,target:run.operation_target,
      capability,path,outcome:tool.state === 'completed' ? 'observed' : 'conflict',
      evidence:{tool_call_id:tool.id,tool:tool.name,state:tool.state,summary:tool.summary,source:'execution_tool_event'},
    };
    await tx.rows(`INSERT INTO endpoint_experiences(evidence_id,bot_id,run_id,target,capability,path,outcome,evidence,tool_call_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(run_id,tool_call_id) DO NOTHING`,[data.evidence_id,data.bot_id,data.run_id,data.target,data.capability,data.path,data.outcome,JSON.stringify(data.evidence),String(tool.id)]);
  }
}
export async function endpointExperience(tx: Tx, botId: string, path?:string) {
  return tx.rows(`WITH grouped AS (
    SELECT target,capability,path,max(verified_at) AS verified_at,count(*)::int AS observations,
      (array_agg(jsonb_build_object('id',evidence_id,'outcome',outcome,'verified_at',verified_at,'resolved_by',resolved_by,'evidence',evidence) ORDER BY verified_at DESC,evidence_id DESC))[1:5] AS recent_evidence,
      (array_agg(jsonb_build_object('id',evidence_id,'verified_at',verified_at,'evidence',evidence) ORDER BY verified_at DESC) FILTER(WHERE outcome='conflict' AND resolved_by IS NULL))[1:5] AS unresolved_conflicts,
      bool_or(outcome='conflict' AND resolved_by IS NULL) AS conflict
    FROM endpoint_experiences WHERE bot_id=$1 AND ($2::text IS NULL OR path=$2) GROUP BY target,capability,path
  ), ranked AS (SELECT *,row_number() OVER(PARTITION BY target ORDER BY verified_at DESC,path NULLS LAST) AS rank FROM grouped)
  SELECT * FROM ranked WHERE rank<=200 ORDER BY target,verified_at DESC`,[botId,path??null]);
}
/** AI selects an exact resource key via its tool; no string inference from user prose. */
export async function resourceExperience(tx: Tx, botId: string, path: string) {
  const rows = await tx.rows('SELECT target,outcome,resolved_by FROM endpoint_experiences WHERE bot_id=$1 AND path=$2',[botId,path]);
  const targets = [...new Set(rows.filter(r=>r.outcome === 'observed').map(r=>String(r.target)))];
  return targets.length === 1 && !rows.some(r=>r.outcome === 'conflict' && !r.resolved_by) ? targets[0] : undefined;
}

/** AI must first obtain a later successful observation on the same endpoint/resource. */
export async function resolveExperienceConflict(tx: Tx, botId: string, conflictId: string, confirmationId: string) {
  const conflict = await tx.one("SELECT * FROM endpoint_experiences WHERE evidence_id=$1 AND bot_id=$2 FOR UPDATE",[conflictId,botId]);
  const confirmation = await tx.one("SELECT * FROM endpoint_experiences WHERE evidence_id=$1 AND bot_id=$2",[confirmationId,botId]);
  if (!conflict || !confirmation || conflict.outcome !== 'conflict' || confirmation.outcome !== 'observed' ||
      conflict.target !== confirmation.target || conflict.path !== confirmation.path || conflict.capability !== confirmation.capability ||
      new Date(confirmation.verified_at).getTime() <= new Date(conflict.verified_at).getTime()) return fail(422,'需要同一智能体、同一执行端和资源的更新成功证据；不得删除冲突');
  await tx.rows('UPDATE endpoint_experiences SET resolved_by=$2 WHERE evidence_id=$1',[conflictId,confirmationId]);
  return {resolved:true,conflict_id:conflictId,confirmation_id:confirmationId};
}
