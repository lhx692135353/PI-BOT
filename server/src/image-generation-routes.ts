import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import { callerRun } from "./agents.js";
import { fail, type Row } from "./db.js";
import { generateImage, generateImageBody, imageConfig, imageConfigBody, saveImageConfig, editImage, editImageBody, imageCapabilities, MAX_GENERATED_IMAGE_BYTES } from "./image-generation.js";
import { annotateImage, annotateImageBody, cropImage, cropImageBody, orientedImage, readImageBody } from "./image-operations.js";
import { resolveImageSource } from "./image-source.js";
import { compressModelImage } from "../../packages/agent/src/model-images.js";
import { artifactOut } from "./reports.js";
import type { Context, Route } from "./routes.js";
import { Vault } from "./security.js";

function writableImageRun(run: Row) {
  if (run.lane !== "task" || run.automation_readonly || run.origin === "automation" || run.cancel_requested)
    fail(403, "图片写入只能在已授权的可写后台任务中执行");
}
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
type Operation = "generate" | "edit" | "annotate" | "crop";
async function perform(c: Context, operation: Operation, body: any) {
  const { db, s, user, llm, reply } = c;
  const inputs = await db.tx(async tx => {
    const run = await callerRun(tx, user.user_id, llm!, body.run_id);
    writableImageRun(run);
    return { source: body.source ? await resolveImageSource(tx, run, body.source) : undefined,
      mask: body.mask ? await resolveImageSource(tx, run, body.mask) : undefined };
  });
  const hash = createHash("sha256").update(JSON.stringify(operation === "generate"
    ? [body.prompt, body.model ?? null, body.aspect_ratio]
    : [operation, { ...body, run_id: undefined, request_id: undefined }, inputs.source && digest(inputs.source.bytes), inputs.mask && digest(inputs.mask.bytes)])).digest("hex");
  const paid = operation === "generate" || operation === "edit";
  const reserved = await db.tx(async tx => {
    await tx.one("SELECT run_id FROM bot_runs WHERE run_id=$1 FOR UPDATE", [body.run_id]);
    const run = await callerRun(tx, user.user_id, llm!, body.run_id);
    writableImageRun(run);
    await tx.rows("UPDATE bot_runs SET expected_output='image' WHERE run_id=$1", [run.run_id]);
    await tx.rows("SELECT pg_advisory_xact_lock(hashtextextended($1,95))", [user.user_id]);
    const previous = await tx.one("SELECT * FROM image_generation_jobs WHERE run_id=$1 AND call_id=$2", [body.run_id, body.request_id]);
    if (previous) {
      if (previous.request_hash !== hash) fail(409, "同一图片调用不能更换操作、原图或参数");
      if (previous.status === "completed" && previous.artifact_id) {
        const artifact = await tx.get("report_artifacts", previous.artifact_id, true);
        return { cached: { artifact: artifactOut(artifact), model: previous.model } };
      }
      fail(409, "这次图片处理已提交，结果尚未确认；请勿重新提交以免重复计费");
    }
    let model = "local", base = "", key = "";
    if (paid) {
      const config = await tx.one("SELECT * FROM image_generation_config WHERE singleton");
      if (!config?.enabled || !config.secret || !config.base_url) fail(503, "尚未启用生图，请管理员配置 CLIProxy");
      model = body.model ?? config!.default_model;
      if (!config!.models.includes(model)) fail(422, "所选图片模型未启用，请先查询 image_models");
      if (body.mask && model !== "gpt-image-2.6-sunburst") fail(422, "所选模型不支持蒙版编辑");
      base = config!.base_url; key = new Vault(s.vaultFile, "image-generation").open(config!.secret, "config");
    }
    await tx.rows("UPDATE image_generation_jobs SET status='unknown' WHERE user_id=$1 AND status='accepted' AND created_at<now()-interval '5 minutes'", [user.user_id]);
    if (await tx.one("SELECT 1 FROM image_generation_jobs WHERE user_id=$1 AND status='accepted'", [user.user_id]))
      fail(429, "已有图片正在处理，请等待完成");
    await tx.rows(`INSERT INTO image_generation_jobs(run_id,call_id,user_id,request_hash,model,status,operation,source_refs)
      VALUES($1,$2,$3,$4,$5,'accepted',$6,$7)`, [body.run_id, body.request_id, user.user_id, hash, model, operation, JSON.stringify([body.source, body.mask].filter(Boolean))]);
    return { base, key, model };
  });
  if (reserved.cached) return reserved.cached;
  const controller = new AbortController();
  const close = () => { if (!reply.raw.writableEnded) controller.abort(); };
  reply.raw.once("close", close);
  if (reply.raw.destroyed) controller.abort();
  const poll = setInterval(() => {
    void db.tx(async tx => writableImageRun(await callerRun(tx, user.user_id, llm!, body.run_id))).catch(() => controller.abort());
  }, 1000);
  try {
    controller.signal.throwIfAborted();
    let image: Awaited<ReturnType<typeof orientedImage>>;
    if (operation === "generate") image = await generateImage(reserved.base!, reserved.key!, { ...body, model: reserved.model }, controller.signal);
    else if (operation === "annotate") image = await annotateImage(inputs.source!.bytes, body.annotations);
    else if (operation === "crop") image = await cropImage(inputs.source!.bytes, body.crop);
    else {
      const source = await orientedImage(inputs.source!.bytes);
      const mask = inputs.mask && await orientedImage(inputs.mask.bytes);
      if (source.bytes.length > 20*1024*1024) fail(413, "编辑原图解码后过大，请先裁剪");
      if (mask && (mask.width !== source.width || mask.height !== source.height || !(await sharp(inputs.mask!.bytes).metadata()).hasAlpha))
        fail(422, "蒙版必须具有透明通道且尺寸与原图一致");
      image = await editImage(reserved.base!, reserved.key!, { ...body, model: reserved.model }, source.bytes, mask?.bytes, controller.signal);
    }
    if (image.bytes.length > MAX_GENERATED_IMAGE_BYTES) fail(413, "处理后的图片超过 10 MiB，请先裁剪");
    return await db.tx(async tx => {
      // Serialize publication with cancellation: whichever holds the run lock first wins.
      await tx.one("SELECT run_id FROM bot_runs WHERE run_id=$1 FOR UPDATE", [body.run_id]);
      const run = await callerRun(tx, user.user_id, llm!, body.run_id);
      if (controller.signal.aborted || run.cancel_requested) fail(499, "图片处理已取消，未发布图片");
      writableImageRun(run);
      const id = randomUUID();
      const title = body.prompt?.slice(0,80) ?? (operation === "crop" ? "裁剪后的图片" : "标注后的图片");
      const row = await tx.insert("report_artifacts", {
        artifact_id: id, user_id: user.user_id, bot_id: run.bot_id, run_id: run.run_id, call_id: `image:${body.request_id}`,
        title, name: `${id}.${image.extension}`, mime: image.mime, size: image.bytes.length, body: image.bytes,
        summary: `${title}（${reserved.model}）`, image_metadata: { operation, source: body.source ?? null, mask: body.mask ?? null, width: image.width, height: image.height },
      });
      await tx.rows("INSERT INTO message_artifacts(message_id,artifact_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [run.assistant_message_id, id]);
      await tx.rows(`INSERT INTO message_artifacts(message_id,artifact_id)
        SELECT p.assistant_message_id,$2 FROM agent_tasks t JOIN bot_runs p ON p.run_id=t.parent_run_id
        WHERE t.child_run_id=$1 AND t.mode='wait' ON CONFLICT DO NOTHING`, [run.run_id, id]);
      await tx.rows("UPDATE image_generation_jobs SET status='completed',artifact_id=$3 WHERE run_id=$1 AND call_id=$2", [run.run_id, body.request_id, id]);
      await tx.notify({ user_id: user.user_id, bot_id: run.bot_id });
      return { artifact: artifactOut(row), model: reserved.model };
    });
  } catch (error) {
    await db.tx(tx => tx.rows("UPDATE image_generation_jobs SET status='unknown' WHERE run_id=$1 AND call_id=$2 AND status='accepted'", [body.run_id, body.request_id])).catch(() => {});
    throw error;
  } finally { clearInterval(poll); reply.raw.off("close", close); }
}

export const imageGenerationRoutes: Route[] = [
  { method: "GET", path: "/admin/api/image-generation", auth: "admin", tag: "admin", summary: "生图配置（不返回密钥）", handler: async ({ tx }) => imageConfig(tx) },
  { method: "PUT", path: "/admin/api/image-generation", auth: "admin", tag: "admin", summary: "配置 CLIProxy 图片模型", body: imageConfigBody,
    handler: async ({ tx, s, body }) => saveImageConfig(tx, s, body) },
  { method: "POST", path: "/agent/image-models", auth: "llm", internal: true, tag: "images", summary: "查询图片模型及能力",
    body: z.object({ run_id: z.string().uuid() }).strict(), handler: async ({ tx, user, llm, body }) => {
      await callerRun(tx, user.user_id, llm!, body.run_id);
      const config = await imageConfig(tx), models = config.enabled && config.configured ? config.models : [];
      return { models, default_model: models.length ? config.default_model : null, capabilities: imageCapabilities(models), annotation: true, crop: true };
    } },
  { method: "POST", path: "/agent/images/read", auth: "llm", internal: true, tag: "images", summary: "读取图片预览与原图尺寸", body: readImageBody,
    handler: async ({ tx, user, llm, body }) => {
      const run = await callerRun(tx, user.user_id, llm!, body.run_id);
      const file = await resolveImageSource(tx, run, body.source), original = await orientedImage(file.bytes);
      const preview = await compressModelImage({ name: file.name, mime_type: file.mime, data: file.bytes.toString("base64") });
      return { source: body.source, name: file.name, width: original.width, height: original.height, coordinates: "normalized, top-left, EXIF-oriented", image: { mime_type: preview.mime_type, data: preview.data } };
    } },
  ...([
    ["generate", generateImageBody], ["edit", editImageBody], ["annotate", annotateImageBody], ["crop", cropImageBody],
  ] as const).map(([operation, schema]): Route => ({ method: "POST", path: `/agent/images/${operation}`, auth: "llm", internal: true, tag: "images",
    summary: `图片 ${operation} 并保存为任务附件`, body: schema, tx: false, handler: async c => perform(c, operation, c.body) })),
];
