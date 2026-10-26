import type { Tx, Row } from "./db.js";
import type { Settings } from "./config.js";
import type { Hub } from "./hub.js";
import { fail } from "./db.js";
import { ensureEnvironment } from "./remote/environments.js";
export const targetDevice = (target: string) =>
  target?.startsWith("device:") ? target.slice(7) : null;
export async function taskTarget(
  tx: Tx,
  s: Settings | undefined,
  hub: Hub,
  userId: string,
  parent: Row,
  bot: Row,
  choice?: string,
  deviceId?: string,
) {
  const modern = parent.source_client !== "legacy" && !!parent.source_client;
  let execution =
    choice ??
    (modern
      ? parent.operation_target?.startsWith("remote")
        ? "remote"
        : parent.operation_target?.startsWith("device:")
          ? "device"
          : "cloud"
      : bot.execution_device_id
        ? "device"
        : "cloud");
  if (parent.execution_policy === "device_only")
    execution = parent.operation_target?.startsWith("remote:")
      ? "remote"
      : "device";
  if (execution === "remote") {
    if (!modern && parent.operation_target === "legacy")
      fail(403, "请升级客户端后使用云端机器操作");
    if (!s) fail(422, "云端环境配置不可用");
    const e = await ensureEnvironment(tx, s!, userId);
    return {
      execution,
      device_id: null,
      operation_target: "remote:" + e.environment_id,
    };
  }
  if (execution === "cloud")
    return {
      execution,
      device_id: null,
      operation_target: modern ? "cloud" : "legacy",
    };
  const id =
    deviceId ??
    targetDevice(parent.operation_target) ??
    bot.execution_device_id;
  if (!id) fail(422, "未指定执行电脑，请明确选择电脑或云端环境");
  if (
    !(await tx.one(
      "SELECT 1 FROM devices WHERE device_id=$1 AND user_id=$2 AND revoked_at IS NULL",
      [id, userId],
    ))
  )
    fail(422, "执行电脑不属于当前用户或已解绑");
  if (modern && !hub.device(userId, id))
    fail(
      409,
      "指定电脑已离线，本次操作未执行；请等待原电脑上线，不能自动换到云端",
    );
  return {
    execution: "device",
    device_id: id,
    operation_target: modern ? "device:" + id : "legacy",
  };
}
export async function targetPrompt(
  tx: Tx,
  s: Settings,
  hub: Hub | undefined,
  userId: string,
  target: string,
  source: string,
) {
  const devices = await tx.rows(
    "SELECT device_id,label,platform FROM devices WHERE user_id=$1 AND revoked_at IS NULL",
    [userId],
  );
  const env = await tx.one(
    "SELECT environment_id,backend,status,capabilities FROM remote_environments WHERE user_id=$1 AND status<>'retired'",
    [userId],
  );
  return `操作位置规则优先于前文关于默认机器的说明：请求来源 ${source}；本轮默认操作目标 ${target}。\n电脑列表：${JSON.stringify(devices.map((d) => ({ ...d, online: hub ? !!hub.device(userId, d.device_id) : "由任务接口检查" })))}\n云端机器：${JSON.stringify({ enabled: s.remoteBackend !== "none", ...env })}\n桌面端的新工作默认在发消息的电脑，安卓端的新机器操作默认 execution=remote。execution=cloud 只用于纯文字和搜索，不提供机器文件。已有任务、文件、目标和历史机器的归属优先于本轮默认位置。不得把用户电脑上的路径当作云端文件；机器离线明确告诉用户，不可自动换机器，只有用户明确别处也有或要求换位置才选择别处。任务一旦创建，不能切换机器；跨机器工作拆成明确指定位置的任务。委托也必须携带相同位置或用户指定位置。文件结果须说明所在机器，使用 artifact 登记云端结果。`;
}
