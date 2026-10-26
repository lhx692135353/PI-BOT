import { randomUUID } from "node:crypto";
import { fail, type Tx, type Row } from "../db.js";
import type { Settings } from "../config.js";
import { Vault } from "../security.js";
import { vmCredentials } from "./kubevirt.js";
export const remoteVault = (s: Settings) => new Vault(s.vaultFile, "remote");
export function environmentOut(env: Row | undefined, backend: string) {
  return {
    backend,
    id: env?.environment_id ?? null,
    status: env?.status ?? (backend === "none" ? "disabled" : "unconfigured"),
    error: env?.error ?? null,
    capabilities: env?.capabilities ?? [],
    config: env?.backend === "ssh" ? env.config : undefined,
  };
}
export async function ensureEnvironment(tx: Tx, s: Settings, userId: string) {
  if (s.remoteBackend === "none") fail(422, "云端操作未开启，请联系管理员");
  await tx.one("SELECT user_id FROM users WHERE user_id=$1 FOR UPDATE", [
    userId,
  ]);
  let env = await tx.one(
    "SELECT * FROM remote_environments WHERE user_id=$1 AND status<>'retired'",
    [userId],
  );
  if (env && env.backend !== s.remoteBackend)
    fail(409, "执行后端已变化，请管理员处理原环境后重新配置");
  if (!env) {
    if (s.remoteBackend === "ssh") fail(422, "请管理员先为此用户配置 SSH 环境");
    const id = randomUUID();
    env = await tx.insert("remote_environments", {
      environment_id: id,
      user_id: userId,
      backend: "kubevirt",
      config: { work_root: "/home/pibot/workspaces" },
      secret: remoteVault(s).seal(JSON.stringify(vmCredentials()), id),
      status: "preparing",
    });
  }
  return env;
}
export async function ownEnvironment(
  tx: Tx,
  s: Settings,
  userId: string,
  id: string,
  allowRetired = false,
) {
  const e = await tx.one(
    "SELECT * FROM remote_environments WHERE user_id=$1 AND environment_id=$2",
    [userId, id],
  );
  if (!e) fail(404, "云端环境不存在");
  if (!allowRetired && e!.status === "retired")
    fail(409, "原执行环境已停用，请明确安排新环境，不能自动迁移");
  if (s.remoteBackend !== e!.backend)
    fail(409, "云端环境后端未启用，不能切换到其他机器");
  return e!;
}
