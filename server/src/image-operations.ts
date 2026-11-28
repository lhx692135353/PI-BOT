import sharp from "sharp";
import { z } from "zod";
import { fail } from "./db.js";
import { imageSourceSchema } from "./image-source.js";

const fraction = z.number().finite().min(0).max(1);
const length = z.number().finite().gt(0).max(1);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#e53935");
const stroke = length.max(0.1).default(0.004);
export const annotationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("point"), x: fraction, y: fraction, radius: length.max(0.2).default(0.008), color }).strict(),
  z.object({ type: z.literal("text"), x: fraction, y: fraction, text: z.string().min(1).max(200), size: length.max(0.3).default(0.04), color }).strict(),
  ...["line", "arrow"].map(type => z.object({ type: z.literal(type as "line" | "arrow"), x1: fraction, y1: fraction, x2: fraction, y2: fraction, width: stroke, color }).strict()),
  z.object({ type: z.literal("rectangle"), x: fraction, y: fraction, width: length, height: length, stroke, color }).strict(),
  z.object({ type: z.literal("circle"), x: fraction, y: fraction, radius: length.max(0.5), stroke, color }).strict(),
]);
export const cropSchema = z.object({ x: fraction, y: fraction, width: length, height: length }).strict()
  .refine(r => r.x + r.width <= 1.0000001 && r.y + r.height <= 1.0000001, "裁剪范围超出原图");
const identity = { run_id: z.string().uuid(), request_id: z.string().min(1).max(200), source: imageSourceSchema };
export const annotateImageBody = z.object({ ...identity, annotations: z.array(annotationSchema).min(1).max(100) }).strict();
export const cropImageBody = z.object({ ...identity, crop: cropSchema }).strict();
export const readImageBody = z.object({ run_id: identity.run_id, source: imageSourceSchema }).strict();
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);

export async function orientedImage(bytes: Buffer) {
  try {
    const { data, info } = await sharp(bytes, { animated: false, limitInputPixels: 40_000_000, failOn: "error" }).rotate().png().toBuffer({ resolveWithObject: true });
    return { bytes: data, width: info.width, height: info.height, mime: "image/png", extension: "png" };
  } catch { return fail(422, "无法解码原图或原图像素超限"); }
}
export async function annotateImage(bytes: Buffer, input: z.infer<typeof annotateImageBody>["annotations"]) {
  const original = await orientedImage(bytes), w = original.width, h = original.height, unit = Math.min(w, h);
  const elements = input.map((mark, index) => {
    const paint = `stroke="${mark.color}" fill="none" stroke-linecap="round"`;
    switch (mark.type) {
      case "point": return `<circle cx="${mark.x*w}" cy="${mark.y*h}" r="${mark.radius*unit}" fill="${mark.color}"/>`;
      case "text": return `<text x="${mark.x*w}" y="${mark.y*h}" fill="${mark.color}" font-family="Noto Sans CJK SC,Microsoft YaHei,sans-serif" font-size="${mark.size*unit}">${escape(mark.text)}</text>`;
      case "circle": return `<circle cx="${mark.x*w}" cy="${mark.y*h}" r="${mark.radius*unit}" ${paint} stroke-width="${mark.stroke*unit}"/>`;
      case "rectangle": {
        if (mark.x + mark.width > 1.0000001 || mark.y + mark.height > 1.0000001) fail(422, "矩形超出原图");
        return `<rect x="${mark.x*w}" y="${mark.y*h}" width="${mark.width*w}" height="${mark.height*h}" ${paint} stroke-width="${mark.stroke*unit}"/>`;
      }
      default: return `${mark.type === "arrow" ? `<defs><marker id="a${index}" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="${mark.color}"/></marker></defs>` : ""}<line x1="${mark.x1*w}" y1="${mark.y1*h}" x2="${mark.x2*w}" y2="${mark.y2*h}" ${paint} stroke-width="${mark.width*unit}" ${mark.type === "arrow" ? `marker-end="url(#a${index})"` : ""}/>`;
    }
  });
  const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${elements.join("")}</svg>`);
  return { ...original, bytes: await sharp(original.bytes).composite([{ input: overlay }]).png().toBuffer() };
}
export async function cropImage(bytes: Buffer, crop: z.infer<typeof cropSchema>) {
  const original = await orientedImage(bytes);
  const left = Math.min(original.width - 1, Math.floor(crop.x * original.width));
  const top = Math.min(original.height - 1, Math.floor(crop.y * original.height));
  const width = Math.max(1, Math.min(original.width - left, Math.round(crop.width * original.width)));
  const height = Math.max(1, Math.min(original.height - top, Math.round(crop.height * original.height)));
  return { ...original, width, height, bytes: await sharp(original.bytes).extract({ left, top, width, height }).png().toBuffer() };
}
