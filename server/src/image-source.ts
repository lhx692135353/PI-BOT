import { z } from "zod";
import { fail, type Row, type Tx } from "./db.js";
import type { ImageSource } from "../../packages/agent/src/image-source.js";
import { MAX_IMAGE_BYTES } from "@pi-bot/agent/images";

export const imageSourceSchema = z.union([
  z.object({ message_id: z.string().uuid(), image_id: z.string().uuid() }).strict(),
  z.object({ artifact_id: z.string().uuid() }).strict(),
]);
export const imageTaskFields = {
  expected_output: z.literal("image").optional(),
  image_refs: z.array(imageSourceSchema).max(10).optional(),
};
export function sameImage(a: ImageSource, b: ImageSource) {
  return "artifact_id" in a ? "artifact_id" in b && a.artifact_id === b.artifact_id
    : "message_id" in b && a.message_id === b.message_id && a.image_id === b.image_id;
}
/** Only new outputs from this task or its descendants count, never input attachments. */
export async function hasImageOutput(tx: Tx, run: Row) {
  return !!await tx.one(`WITH RECURSIVE descendants(run_id) AS (
    SELECT $2::uuid UNION SELECT t.child_run_id FROM agent_tasks t JOIN descendants d ON t.parent_run_id=d.run_id WHERE t.child_run_id IS NOT NULL
  ) SELECT 1 FROM message_artifacts ma JOIN report_artifacts a USING(artifact_id)
    WHERE ma.message_id=$1 AND a.run_id IN (SELECT run_id FROM descendants)
      AND a.mime IN ('image/png','image/jpeg','image/webp') LIMIT 1`, [run.assistant_message_id, run.run_id]);
}
/** Explicit grants are validated by the parent before a child run is created. */
export async function resolveImageSource(tx: Tx, run: Row, source: ImageSource) {
  const granted = (run.image_refs ?? []).some((ref: ImageSource) => sameImage(ref, source));
  let bytes: Buffer, mime: string, name: string;
  if ("artifact_id" in source) {
    const row = await tx.one(`SELECT a.* FROM report_artifacts a WHERE a.artifact_id=$1 AND a.user_id=$2
      AND ($4 OR a.bot_id=$3 OR EXISTS(SELECT 1 FROM message_artifacts ma JOIN bot_messages m USING(message_id)
        WHERE ma.artifact_id=a.artifact_id AND m.bot_id=$3))`, [source.artifact_id, run.user_id, run.bot_id, granted]);
    if (!row) return fail(404, "图片不存在或未共享给本任务");
    bytes = Buffer.from(row.body); mime = row.mime; name = row.name;
  } else {
    const row = await tx.one(`SELECT m.images FROM bot_messages m JOIN bots b USING(bot_id)
      WHERE m.message_id=$1 AND b.user_id=$2 AND (m.bot_id=$3 OR $4)`, [source.message_id, run.user_id, run.bot_id, granted]);
    const image = row?.images?.find((value: { id: string }) => value.id === source.image_id);
    if (!image) return fail(404, "消息图片不存在或未共享给本任务");
    bytes = Buffer.from(image.data, "base64"); mime = image.mime_type; name = image.name;
  }
  if (!/^image\/(png|jpeg|webp|gif)$/.test(mime)) return fail(422, "来源不是支持的图片");
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return fail(413, "原图超过大小限制");
  return { bytes, mime, name };
}
