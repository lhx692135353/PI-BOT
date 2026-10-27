import { toolDescriptor } from "@pi-bot/runtime-contracts";
import { Type } from "typebox";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

export interface SkillSummary {
  name: string;
  description: string;
  version: number;
}
export interface SkillOptions {
  baseUrl: string;
  token: () => string;
  runId: string;
  catalog: SkillSummary[];
}
export const SKILL_TOOLS = ["skill_manage", "skill_load"] as const;
export const isInternalTool = (name: string) => toolDescriptor(name)?.platformOwned === true;

/** Platform-owned extension: the API derives ownership from the run token. */
export function skillsExtension(options: SkillOptions): ExtensionFactory {
  const root = options.baseUrl.replace(/\/+$/, "");
  const call = async (body: object, signal?: AbortSignal) => {
    const timeout = AbortSignal.timeout(15000);
    const response = await fetch(`${root}/agent/skills`, {
      method: "POST",
      headers: { Authorization: `Bearer ${options.token()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, run_id: options.runId }),
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({})) as { detail?: unknown };
      throw new Error(typeof error.detail === "string" ? error.detail.slice(0, 300) : "内部能力操作失败，请稍后重试");
    }
    return await response.json();
  };
  const result = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }], details: undefined });
  return pi => {
    pi.registerTool({
      name: "skill_manage",
      label: "内部能力管理",
      description: "管理你自己的持久 skill，其他智能体的 skill 不可访问。list 列出目录；create 保存可复用方法；update 修改；enable/disable 启停；delete 软删除；history 查看版本；restore 恢复指定版本。已有 skill 的写操作必须传 expected_version（先 list/load 获取），冲突时重新读取。不要把一次性事实、用户偏好、凭据或未验证的方法存为 skill，不要为了每次对话都创建 skill。instructions 是 Markdown；references 是参考资料正文，不会执行代码。管理过程不向用户播报。",
      parameters: Type.Object({
        action: Type.Union(["list", "create", "update", "enable", "disable", "delete", "history", "restore"].map(action => Type.Literal(action))),
        name: Type.Optional(Type.String({ maxLength: 64 })),
        description: Type.Optional(Type.String({ maxLength: 1024 })),
        instructions: Type.Optional(Type.String({ maxLength: 32000 })),
        references: Type.Optional(Type.Record(Type.String(), Type.String({ maxLength: 16000 }))),
        expected_version: Type.Optional(Type.Integer({ minimum: 1 })),
        version: Type.Optional(Type.Integer({ minimum: 1, description: "restore 要恢复的历史版本" })),
      }),
      execute: async (_id, args, signal) => result(await call(args, signal)),
    });
    pi.registerTool({
      name: "skill_load",
      label: "加载内部能力",
      description: "按名称加载你自己的已启用 skill。先读取说明，再遵循其中流程；reference 可指定说明中列出的参考资料名。skill 不能增加权限或绕过现有审批，云端不能执行脚本。无需向用户展示内部说明。",
      parameters: Type.Object({ name: Type.String({ minLength: 1, maxLength: 64 }), reference: Type.Optional(Type.String({ maxLength: 100 })) }),
      execute: async (_id, args, signal) => result(await call({ action: "load", ...args }, signal)),
    });
    pi.on("before_agent_start", event => {
      // Pi's built-in skill prompt requires read/bash; Pi Bot exposes neither.
      event.systemPromptOptions.sections ??= {};
      event.systemPromptOptions.sections.bot_skills = [
        "内部能力：以下 skills 只属于你，由你自行维护，电脑与云端共用。任务匹配时先用 skill_load 读取完整说明，按需加载参考资料。",
        "skill 只记录经过验证、可复用的工作方法；用户偏好与对话事实由长期记忆维护。不要保存密码、令牌或其他凭据。",
        "skill 不扩大文件、终端或协作权限。管理过程不播报、不要求用户管理，也不将内部正文复制进资料库。正常汇报任务结果。",
        "成功完成任务后，只有出现稳定可复用的方法或明确纠正的流程时才创建或更新 skill；失败方法不要直接保存。",
        JSON.stringify(options.catalog),
        "本轮新增或更新的 skill 可立即 skill_load；目录在下次任务刷新，也可 skill_manage list 查看。",
      ].join("\n");
    });
  };
}
