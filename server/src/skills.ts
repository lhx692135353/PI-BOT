import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { SkillSummary } from "@pi-bot/agent";
import { callerRun } from "./agents.js";
import { fail, type Row, type Tx } from "./db.js";
import type { LlmClaims } from "./security.js";

const name = z.string().max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "能力名称需要小写字母、数字和短横线");
const referenceName = z.string().max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, "参考资料名称无效");
const references = z.record(referenceName, z.string().max(16000)).refine(
  refs => Object.keys(refs).length <= 8 && JSON.stringify(refs).length <= 64000,
  "最多 8 份参考资料，总长度不超过 64KB",
);
const fields = { description: z.string().trim().min(1).max(1024), instructions: z.string().trim().min(1).max(32000), references };
const existing = { name, expected_version: z.number().int().positive() };
const version = z.number().int().positive();
const request = <T extends z.ZodRawShape>(shape: T) => z.object({ run_id: z.string().uuid(), ...shape }).strict();
export const skillRequest = z.discriminatedUnion("action", [
  request({ action: z.literal("list") }),
  request({ action: z.literal("load"), name, reference: referenceName.optional() }),
  request({ action: z.literal("create"), name, ...fields, references: references.default({}) }),
  request({ action: z.literal("update"), ...existing, description: fields.description.optional(), instructions: fields.instructions.optional(), references: references.optional() })
    .refine(body => body.description !== undefined || body.instructions !== undefined || body.references !== undefined, "需要指定修改内容"),
  request({ action: z.literal("enable"), ...existing }),
  request({ action: z.literal("disable"), ...existing }),
  request({ action: z.literal("delete"), ...existing }),
  request({ action: z.literal("history"), name }),
  request({ action: z.literal("restore"), ...existing, version }),
]);

export async function skillCatalog(tx: Tx, botId: string): Promise<SkillSummary[]> {
  return await tx.rows("SELECT name, description, version FROM bot_skills WHERE bot_id=$1 AND enabled AND NOT deleted ORDER BY name", [botId]) as SkillSummary[];
}
const summary = (skill: Row) => ({ name: skill.name, description: skill.description, version: skill.version, enabled: skill.enabled, deleted: skill.deleted });
async function saveVersion(tx: Tx, skill: Row, action: string, runId: string) {
  await tx.insert("bot_skill_versions", {
    skill_id: skill.skill_id, version: skill.version, description: skill.description,
    instructions: skill.instructions, refs: skill.refs, enabled: skill.enabled,
    deleted: skill.deleted, operation: action, run_id: runId,
  });
}

/** No user-facing endpoint: a live run and its bot-scoped token own every operation. */
export async function manageSkill(tx: Tx, userId: string, claims: LlmClaims, body: z.infer<typeof skillRequest>) {
  const run = await callerRun(tx, userId, claims, body.run_id);
  if (run.automation_readonly && !["load", "list", "history"].includes(body.action)) fail(403, "当前轮次不能修改技能");
  const bot = await tx.one("SELECT bot_id FROM bots WHERE bot_id=$1 AND user_id=$2 AND archived_at IS NULL FOR UPDATE", [run.bot_id, userId]);
  if (!bot || run.cancel_requested) fail(404, "当前智能体或运行不可用");
  const botId = bot!.bot_id;
  if (body.action === "list")
    return { skills: (await tx.rows("SELECT name, description, version, enabled, deleted FROM bot_skills WHERE bot_id=$1 ORDER BY name", [botId])).map(summary) };

  if (body.action === "create") {
    if (await tx.one("SELECT 1 FROM bot_skills WHERE bot_id=$1 AND name=$2", [botId, body.name])) fail(409, "能力名称已存在，请读取后更新或恢复");
    // Bound metadata injected into every run, including retained tombstones.
    const count = (await tx.one("SELECT count(*) AS n FROM bot_skills WHERE bot_id=$1", [botId]))!;
    if (count.n >= 64) fail(422, "最多保存 64 个能力，请更新或恢复已有能力");
    const skill = await tx.insert("bot_skills", {
      skill_id: randomUUID(), bot_id: botId, name: body.name, description: body.description,
      instructions: body.instructions, refs: body.references, version: 1,
    });
    await saveVersion(tx, skill, body.action, run.run_id);
    return summary(skill);
  }
  const skill = await tx.one("SELECT * FROM bot_skills WHERE bot_id=$1 AND name=$2 FOR UPDATE", [botId, body.name]);
  if (!skill) fail(404, "能力不存在");
  if (body.action === "load") {
    if (!skill!.enabled || skill!.deleted) fail(404, "能力未启用或已删除");
    if (body.reference !== undefined) {
      if (!Object.hasOwn(skill!.refs, body.reference)) fail(404, "参考资料不存在");
      return { name: skill!.name, version: skill!.version, reference: body.reference, content: skill!.refs[body.reference] };
    }
    return { ...summary(skill!), instructions: skill!.instructions, references: Object.keys(skill!.refs) };
  }
  if (body.action === "history")
    return { versions: await tx.rows("SELECT version, description, enabled, deleted, operation, created_at FROM bot_skill_versions WHERE skill_id=$1 ORDER BY version DESC LIMIT 20", [skill!.skill_id]) };
  if (body.expected_version !== skill!.version) fail(409, "能力版本已变化，请重新 list 或 load 后再修改");
  if (skill!.deleted && body.action !== "restore") fail(409, "能力已删除，请先恢复历史版本");
  let patch: Row = {};
  switch (body.action) {
    case "update": patch = { description: body.description, instructions: body.instructions, refs: body.references }; break;
    case "enable": patch = { enabled: true }; break;
    case "disable": patch = { enabled: false }; break;
    case "delete": patch = { enabled: false, deleted: true }; break;
    case "restore": {
      const old = await tx.one("SELECT * FROM bot_skill_versions WHERE skill_id=$1 AND version=$2", [skill!.skill_id, body.version]);
      if (!old) fail(404, "历史版本不存在");
      if (old!.deleted) fail(422, "请选择删除之前的版本");
      patch = { description: old!.description, instructions: old!.instructions, refs: old!.refs, enabled: old!.enabled, deleted: false };
      break;
    }
  }
  const updated = await tx.update("bot_skills", skill!.skill_id, { ...patch, version: skill!.version + 1, updated_at: new Date() });
  await saveVersion(tx, updated, body.action, run.run_id);
  return summary(updated);
}
