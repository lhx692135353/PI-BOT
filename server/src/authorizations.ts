import { randomUUID } from 'node:crypto';
import { posix, win32 } from 'node:path';
import { z } from 'zod';
import { fail, type Row, type Tx } from './db.js';
import { callerRun } from './agents.js';
import type { Route } from './routes.js';

export type Access = 'read' | 'write' | 'execute' | 'legacy';
export interface AuthorizationScope {
  target: string; target_label: string; platform: string; operation: Access;
  resource: string; resource_type: 'file' | 'directory' | 'unknown';
}
export function normalizedResource(resource: string, platform: string): string | null {
  const paths = platform === 'win32' ? win32 : posix;
  if (!resource || /[\x00-\x1f]/.test(resource) || !paths.isAbsolute(resource)) return null;
  if (platform === 'win32' && (!/^[A-Za-z]:[\\/]/.test(resource) || resource.slice(2).includes(':'))) return null;
  const value = paths.normalize(resource).replace(platform === 'win32' ? /\\$/ : /\/$/, '');
  if (value === paths.parse(value).root.replace(/[\\/]$/, '') || ['/home','/root','/Users'].includes(value)) return null;
  // Executors send realpath results. Preserve component casing so Windows
  // directories explicitly configured as case-sensitive cannot broaden a rule.
  return platform === 'win32' ? value.replace(/^[a-z]:/,drive => drive.toUpperCase()) : value;
}
export function resourceMatches(rule: Pick<AuthorizationScope, 'platform' | 'resource' | 'resource_type'>, resource: string): boolean {
  const root = normalizedResource(rule.resource, rule.platform), value = normalizedResource(resource, rule.platform);
  return !!root && !!value && (value === root || (rule.resource_type === 'directory' && value.startsWith(root + (rule.platform === 'win32' ? '\\' : '/'))));
}
export async function approvalScope(tx: Tx, run: Row, resource: string, operation: Access, resourceType: AuthorizationScope['resource_type']): Promise<AuthorizationScope> {
  const device = run.executor === 'device' && run.device_id ? await tx.get('devices', run.device_id) : null;
  const target = device ? `device:${device.device_id}` : String(run.operation_target ?? 'cloud');
  const environment = target.startsWith('remote:') ? await tx.get('remote_environments', target.slice(7)) : null;
  return { target, target_label: device?.label ?? (environment ? '云端电脑' : '云端'), platform: device?.platform ?? 'linux',
    operation, resource, resource_type: resourceType };
}
export function canRemember(scope: AuthorizationScope | undefined): boolean {
  return !!scope && scope.operation === 'read' && ['file','directory'].includes(scope.resource_type) &&
    /^(device|remote):[0-9a-f-]{36}$/.test(scope.target) && !!normalizedResource(scope.resource, scope.platform);
}
export function scopeText(scope: AuthorizationScope | undefined): string {
  if (!scope) return '仅本次任务访问此路径；旧版执行端未提供可保存的权限范围。';
  const operation = { read: '读取', write: '写入或修改', execute: '执行命令', legacy: '读写及命令工作目录访问（旧版）' }[scope.operation];
  return `当前账号 · ${scope.target_label} · ${operation} · ${scope.resource}${scope.resource_type === 'directory' ? ' 及其子路径' : ''}。${scope.operation === 'read' ? '不包含写入、删除或执行命令。' : '此操作仅允许本次任务，不能保存为持久授权。'}`;
}
export async function authorizationLog(tx: Tx, userId: string, scope: AuthorizationScope, action: string, ids: Row = {}) {
  await tx.insert('authorization_logs', { user_id: userId, target: scope.target, operation: scope.operation, resource: scope.resource, action, ...ids });
}
export async function rememberAuthorization(tx: Tx, approval: Row) {
  const scope = approval.detail.authorization_scope as AuthorizationScope | undefined;
  if (!canRemember(scope)) fail(422, '只能记住明确资源的读取权限；写入、命令和旧版宽泛授权需逐次确认');
  const s = scope!;
  const rule = (await tx.one(`INSERT INTO saved_authorizations(authorization_id,user_id,target,target_label,platform,operation,resource,resource_type,source_approval_id)
    VALUES($1,$2,$3,$4,$5,'read',$6,$7,$8)
    ON CONFLICT(user_id,target,operation,resource,resource_type) WHERE revoked_at IS NULL DO UPDATE SET target_label=EXCLUDED.target_label RETURNING *`,
  [randomUUID(), approval.user_id, s.target, s.target_label, s.platform, normalizedResource(s.resource,s.platform), s.resource_type, approval.approval_id]))!;
  await authorizationLog(tx, approval.user_id, s, 'grant', { authorization_id: rule.authorization_id, approval_id: approval.approval_id, run_id: approval.run_id });
  return rule;
}
/** Invoked immediately before each saved access. No client-side grant cache survives revocation. */
export async function matchAuthorization(tx: Tx, run: Row, resource: string, operation: Access): Promise<Row | null> {
  if (operation !== 'read' || run.cancel_requested || !['running','waiting_approval'].includes(run.status)) return null;
  const scope = await approvalScope(tx, run, resource, operation, 'unknown');
  if (run.executor === 'device' && !await tx.one('SELECT 1 FROM devices WHERE device_id=$1 AND user_id=$2 AND revoked_at IS NULL', [run.device_id,run.user_id])) return null;
  const rules = await tx.rows(`SELECT * FROM saved_authorizations WHERE user_id=$1 AND target=$2 AND operation=$3 AND revoked_at IS NULL ORDER BY length(resource) DESC FOR UPDATE`, [run.user_id,scope.target,operation]);
  const rule = rules.find(r => resourceMatches(r as AuthorizationScope, resource));
  if (!rule) return null;
  await tx.rows('UPDATE saved_authorizations SET last_used_at=now() WHERE authorization_id=$1', [rule.authorization_id]);
  await authorizationLog(tx, run.user_id, scope, 'use', { authorization_id: rule.authorization_id, run_id: run.run_id });
  return rule;
}
const ruleOut = (r: Row) => ({ id:r.authorization_id, target:r.target, target_label:r.target_label, operation:r.operation, resource:r.resource, resource_type:r.resource_type, created_at:r.created_at, last_used_at:r.last_used_at });
export const authorizationRoutes: Route[] = [
  { method:'GET', path:'/authorizations', auth:'actor', tag:'bots', summary:'查看当前账号已保存授权',
    handler: async ({tx,user}) => (await tx.rows('SELECT * FROM saved_authorizations WHERE user_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC', [user.user_id])).map(ruleOut) },
  { method:'GET', path:'/authorizations/logs', auth:'actor', tag:'bots', summary:'查看最近授权及使用日志',
    handler: async ({tx,user}) => (await tx.rows('SELECT * FROM authorization_logs WHERE user_id=$1 ORDER BY log_id DESC LIMIT 100',[user.user_id])).map(r => ({id:r.log_id, action:r.action, target:r.target, operation:r.operation, resource:r.resource, authorization_id:r.authorization_id, approval_id:r.approval_id, run_id:r.run_id, created_at:r.created_at})) },
  { method:'DELETE', path:'/authorizations/:id', auth:'actor', tag:'bots', summary:'撤销当前账号的已保存授权',
    handler: async ({tx,user,params}) => {
      const rule = await tx.one('UPDATE saved_authorizations SET revoked_at=now() WHERE authorization_id=$1 AND user_id=$2 AND revoked_at IS NULL RETURNING *',[params.id,user.user_id]);
      if (!rule) fail(404,'授权不存在或已撤销');
      await authorizationLog(tx,user.user_id,rule as AuthorizationScope,'revoke',{authorization_id:rule!.authorization_id});
      await tx.notify({user_id:user.user_id});
      return {revoked:true};
    } },
  { method:'POST', path:'/agent/authorizations/check', auth:'llm', internal:true, tag:'agent', summary:'执行电脑逐次匹配持久授权并记录使用',
    body:z.object({run_id:z.string().uuid(),path:z.string().min(1).max(4000),access:z.enum(['read','write','execute'])}).strict(),
    handler: async ({tx,user,llm,body}) => {
      const run = await callerRun(tx,user.user_id,llm!,body.run_id);
      if (run.executor !== 'device' || run.lane !== 'task') fail(403,'仅执行电脑任务可以匹配本机授权');
      return {approved:!!await matchAuthorization(tx,run,body.path,body.access)};
    } },
];
