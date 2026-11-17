import { createHash } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";

export interface TaskWorkflowOptions {
  enabled: boolean;
  coding?: boolean;
  api: string;
  token: () => string;
  runId: string;
  review: (request: string, signal?: AbortSignal) => Promise<string>;
}

const result = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
const codePath = /(?:\.(?:[cm]?[jt]sx?|py|rs|go|swift|kt|java|cs|rb|c|cc|cpp|h|hpp|sql|vue|svelte|gradle)|(?:^|[/\\])(?:package\.json|Cargo\.toml|go\.mod|Dockerfile|Makefile))$/i;
export const reviewTools = new Set(["list_files", "read_file", "search_files"]);
const mutable = new Set(["run_command", "edit_file", "write_file", "file_fetch"]);
const developmentCommand = /(?:^|[\s;/|&])(?:apply_patch|tsc|tsx|gradle(?:w)?|xcodebuild|cargo|npm|pnpm|yarn|bun|pytest|npx|eslint|vitest|jest)\b/i;

// Adapted from pstack-claude, commit a12b04786023e762f12f5de7bb5fafb8c23f8c36.
const workflow = {
  focused: "先复现并记录预期和实际结果，再做最小改动，运行针对性验证并检查变更。",
  full: "先阅读项目约定和现有入口，记录设计、验收条件和待确认事项。实现后运行验证，交给独立只读审查，再核对审查结果和最终 diff。",
};

export function superviseTask(o: TaskWorkflowOptions, tools: ToolDefinition[]) {
  let coding = !!o.coding;
  let mode: keyof typeof workflow | undefined;
  let verified = false;
  let reviewed = false;
  let finished = false;
  let paused: string | undefined;
  const executionTools = tools.map(tool => ({
    ...tool,
    execute: async (...args: Parameters<ToolDefinition["execute"]>) => {
      if (paused) throw new Error("任务已保存检查点，等待用户答复");
      if (o.enabled && mutable.has(tool.name)) {
        const input = args[1] as { path?: string; command?: string };
        if ((input?.path && codePath.test(input.path)) || (input?.command && developmentCommand.test(input.command)))
          coding = true;
        if (coding && !mode) throw new Error("请先用 pstack 的 begin 步骤进入开发流程");
        if (coding) { verified = false; reviewed = false; finished = false; }
      }
      return tool.execute(...args);
    },
  }) as ToolDefinition);
  if (o.enabled) executionTools.push({
    name: "pstack", executionMode: "sequential", label: "pstack 开发流程",
    description: "begin 记录小修或完整开发的设计与测试计划，verify 记录验证，review 发起独立只读审查，finish 记录收尾。先 begin 再改代码。",
    parameters: Type.Object({
      step: Type.Union(["begin", "verify", "review", "finish"].map(step => Type.Literal(step))),
      mode: Type.Optional(Type.Union([Type.Literal("focused"), Type.Literal("full")])),
      evidence: Type.String({ minLength: 1, maxLength: 4000 }),
    }),
    execute: async (_id, input: { step: string; mode?: keyof typeof workflow; evidence: string }, signal) => {
      if (paused) throw new Error("任务已暂停");
      if (input.step === "begin") {
        if (mode) throw new Error("开发流程已经开始");
        coding = true;
        mode = input.mode ?? "focused";
        return result(`${workflow[mode]} 已记录计划：${input.evidence}`);
      }
      if (!mode) throw new Error("请先开始 pstack 开发流程");
      if (input.step === "verify") { verified = true; return result("验证结果已记录"); }
      if (!verified) throw new Error("请先记录验证结果");
      if (input.step === "review") {
        const findings = await o.review(input.evidence, signal);
        reviewed = true;
        return result(findings);
      }
      if (mode === "full" && !reviewed) throw new Error("完整开发流程需要独立只读审查");
      finished = true;
      return result("开发流程已完成");
    },
  } as ToolDefinition);
  executionTools.push({
    name: "task_pause", executionMode: "sequential", label: "保存进展并询问用户",
    description: "任务缺少用户决策或反复失败无法再推进时，保存检查点并提出具体问题。用量提醒本身不要求暂停。",
    parameters: Type.Object({
      question: Type.String({ minLength: 1, maxLength: 1000 }),
      progress: Type.String({ minLength: 1, maxLength: 4000 }),
      next: Type.String({ minLength: 1, maxLength: 2000 }),
    }),
    execute: async (id, input: { question: string; progress: string; next: string }, signal) => {
      if (paused) return result(paused);
      const response = await fetch(`${o.api}/agent/task-pause`, {
        method: "POST", headers: { Authorization: `Bearer ${o.token()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ...input, run_id: o.runId, request_id: id }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
        redirect: "error",
      });
      if (!response.ok) throw new Error("无法保存任务暂停点，请先确认任务状态");
      paused = `任务已暂停。\n已完成：${input.progress}\n需要你确认：${input.question}\n下一步：${input.next}`;
      return result(paused);
    },
  } as ToolDefinition);
  const recent: string[] = [];
  let lastWarning: string | undefined;
  const extension: ExtensionFactory = pi => {
    pi.on("before_agent_start", event => {
      event.systemPromptOptions.sections ??= {};
      event.systemPromptOptions.sections.task_supervision = [
        "需要用户决策或重复尝试没有新进展时，调用 task_pause 保存进度并提出具体问题。",
        o.enabled ? "账号启用了 pstack。写代码前先调用 pstack begin。小修使用 focused，大范围修改使用 full。运行项目验证后调用 verify，完整开发还要调用 review，最终调用 finish。" : "",
      ].filter(Boolean).join("\n");
    });
    pi.on("tool_call", () => paused ? { block: true, terminate: true, reason: "任务已保存检查点，等待用户答复" } : undefined);
    pi.on("tool_result", (event, ctx) => {
      if (paused && event.toolName === "task_pause") ctx.abort();
      if (["task_pause", "pstack"].includes(event.toolName)) return;
      const output = event.content.filter(item => item.type === "text").map(item => item.text).join("\n");
      const fingerprint = createHash("sha256").update(JSON.stringify([event.toolName, event.input, output])).digest("hex");
      recent.push(fingerprint);
      if (recent.length > 6) recent.shift();
      if (recent.filter(item => item === fingerprint).length < 3 || lastWarning === fingerprint) return;
      lastWarning = fingerprint;
      return { content: [...event.content, { type: "text", text: `进展检查：工具 ${event.toolName} 在最近六次操作中至少三次返回相同结果。确认是否有新证据，尝试不同方法，或保存检查点并询问用户。` }] };
    });
  };
  return { tools: executionTools, extension, paused: () => paused, incomplete: () => o.enabled && coding && !finished };
}
