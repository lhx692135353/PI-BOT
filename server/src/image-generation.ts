import sharp from "sharp";
import { z } from "zod";
import { fail, HttpError, type Tx } from "./db.js";
import type { Settings } from "./config.js";
import { Vault } from "./security.js";
import { imageSourceSchema } from "./image-source.js";

export const IMAGE_MODELS = ["grok-imagine-image-2.0", "gpt-image-2.6-sunburst", "gemini-3.1-flash-image"] as const;
export const IMAGE_GENERATION_TIMEOUT_MS = 180000;
export const MAX_GENERATED_IMAGE_BYTES = 10 * 1024 * 1024;
const model = z.enum(IMAGE_MODELS);
export const imageConfigBody = z.object({
  enabled: z.boolean(), base_url: z.string().trim().max(500),
  models: z.array(model).min(1).max(IMAGE_MODELS.length), default_model: model,
  api_key: z.string().trim().max(8192).optional(),
}).strict().refine(value => new Set(value.models).size === value.models.length && value.models.includes(value.default_model),
  "默认模型必须在已启用的模型中，模型不能重复");
export const generateImageBody = z.object({
  run_id: z.string().uuid(), request_id: z.string().min(1).max(200),
  prompt: z.string().trim().min(1).max(8000), model: model.optional(),
  aspect_ratio: z.enum(["1:1", "3:2", "2:3"]).default("1:1"),
}).strict();
export type GenerateImageInput = z.infer<typeof generateImageBody>;
export const editImageBody = generateImageBody.omit({ aspect_ratio: true }).extend({
  source: imageSourceSchema, mask: imageSourceSchema.optional(),
  aspect_ratio: z.enum(["1:1", "3:2", "2:3"]).optional(),
}).strict();
export const imageCapabilities = (models: string[]) => Object.fromEntries(models.map(name => [name, {
  generate: true, edit: true, mask: name === "gpt-image-2.6-sunburst",
}]));

export function imageBaseUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { return fail(422, "请填写 CLIProxy 的 HTTP(S) 地址"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    fail(422, "CLIProxy 地址不能携带账号、查询参数或片段，只接受 HTTP(S)");
  // Accept both the gateway root and its OpenAI /v1 base, with optional path prefix.
  return `${url.origin}${url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "")}`;
}
export async function imageConfig(tx: Tx) {
  const row = await tx.one("SELECT * FROM image_generation_config WHERE singleton");
  return { enabled: row?.enabled === true, base_url: String(row?.base_url ?? ""),
    models: (row?.models ?? [...IMAGE_MODELS]) as string[], default_model: String(row?.default_model ?? IMAGE_MODELS[1]),
    configured: !!row?.secret };
}
export async function saveImageConfig(tx: Tx, s: Settings, value: unknown) {
  const body = imageConfigBody.parse(value);
  const base = body.base_url ? imageBaseUrl(body.base_url) : "";
  const current = await tx.one("SELECT secret FROM image_generation_config WHERE singleton FOR UPDATE");
  if (body.enabled && (!base || (!body.api_key && !current?.secret))) fail(422, "启用生图需要 CLIProxy 地址和 API Key");
  const secret = body.api_key ? new Vault(s.vaultFile, "image-generation").seal(body.api_key, "config") : null;
  await tx.rows(`UPDATE image_generation_config SET enabled=$1,base_url=$2,models=$3::jsonb,default_model=$4,
    secret=coalesce($5::jsonb,secret),updated_at=now() WHERE singleton`,
    [body.enabled, base, JSON.stringify(body.models), body.default_model, secret ? JSON.stringify(secret) : null]);
  return imageConfig(tx);
}

export function generationRequest(base: string, input: Pick<GenerateImageInput, "prompt" | "model" | "aspect_ratio">) {
  if (input.model === "gemini-3.1-flash-image") return {
    url: `${base}/v1beta/models/${input.model}:generateContent`,
    body: { contents: [{ role: "user", parts: [{ text: input.prompt }] }], generationConfig: {
      responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: input.aspect_ratio },
    } },
  };
  const sizes = { "1:1": "1024x1024", "3:2": "1536x1024", "2:3": "1024x1536" };
  return { url: `${base}/v1/images/generations`, body: {
    model: input.model, prompt: input.prompt, n: 1, response_format: "b64_json", size: sizes[input.aspect_ratio],
  } };
}

/** Read under a byte cap even when the gateway omits or lies about Content-Length. */
async function responseJson(response: Response) {
  const maximum = Math.ceil(MAX_GENERATED_IMAGE_BYTES / 3) * 4 + 1024 * 1024;
  const reader = response.body?.getReader();
  if (!reader) fail(502, "生图服务返回了空响应");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader!.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > maximum) fail(502, "生图响应超过大小限制，请降低图片尺寸");
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    fail(502, "生图服务返回了无效响应");
  } finally { await reader!.cancel().catch(() => {}); }
}

export async function generatedImage(payload: any, gemini: boolean) {
  let encoded: unknown;
  if (gemini) {
    // Ignore model thought images; only the final visible candidate is published.
    const parts = payload?.candidates?.[0]?.content?.parts;
    const part = Array.isArray(parts) ? parts.find(p => p && !p.thought && (p.inlineData || p.inline_data)) : undefined;
    encoded = (part?.inlineData ?? part?.inline_data)?.data;
  } else {
    const item = payload?.data?.[0];
    encoded = item?.b64_json;
    if (!encoded && typeof item?.url === "string" && /^data:image\/(png|jpeg|webp);base64,/.test(item.url))
      encoded = item.url.slice(item.url.indexOf(",") + 1);
  }
  // Never fetch provider-controlled URLs (including private-network addresses).
  if (typeof encoded !== "string" || !encoded.length) return fail(502, "未返回可用图片，请检查模型权限或内容限制；网关需返回 base64 图片");
  if (encoded.length > Math.ceil(MAX_GENERATED_IMAGE_BYTES / 3) * 4) fail(502, "生成图片超过 10 MiB，请降低图片尺寸");
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.length > MAX_GENERATED_IMAGE_BYTES || bytes.toString("base64") !== encoded)
    fail(502, "生图服务返回了无效图片数据");
  try {
    const image = sharp(bytes, { limitInputPixels: 40000000, failOn: "error" });
    const info = await image.metadata();
    if (!info.width || !info.height || !["png", "jpeg", "webp"].includes(info.format ?? "") || (info.pages ?? 1) > 1)
      fail(502, "仅支持 PNG、JPEG 和 WebP 静态图片");
    // Decode the image as well as its header to reject corrupt/truncated provider data.
    await image.stats();
    return { bytes, mime: `image/${info.format}`, extension: info.format === "jpeg" ? "jpg" : info.format,
      width: info.width, height: info.height };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    return fail(502, "生成图片无法解码或尺寸超过限制，请重试");
  }
}

export async function generateImage(base: string, key: string, input: GenerateImageInput, signal?: AbortSignal, request: typeof fetch = fetch) {
  const abort = signal ? AbortSignal.any([signal, AbortSignal.timeout(IMAGE_GENERATION_TIMEOUT_MS)]) : AbortSignal.timeout(IMAGE_GENERATION_TIMEOUT_MS);
  const target = generationRequest(base, input);
  try {
    const response = await request(target.url, { method: "POST", redirect: "error", signal: abort,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(target.body) });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 401 || response.status === 403) fail(502, "CLIProxy 认证或模型访问被拒绝，请管理员检查配置");
      if (response.status === 429) fail(503, "生图服务请求过于频繁，请稍后重试");
      fail(502, `生图服务暂时无法生成图片（HTTP ${response.status}）`);
    }
    const image = await generatedImage(await responseJson(response), input.model === "gemini-3.1-flash-image");
    abort.throwIfAborted();
    return image;
  } catch (error) {
    if (signal?.aborted) return fail(499, "生图已取消，未发布图片");
    if (abort.aborted) return fail(504, "生图超时，未确认结果，请勿自动重复生成");
    if (error instanceof HttpError) throw error;
    return fail(502, "无法连接生图服务，结果未确认，请勿自动重复生成");
  }
}

/** Edit transports always contain the actual source, never just its description. */
export async function editImage(base: string, key: string, input: z.infer<typeof editImageBody>, image: Buffer,
  mask?: Buffer, signal?: AbortSignal, request: typeof fetch = fetch) {
  if (mask && input.model !== "gpt-image-2.6-sunburst") fail(422, "所选模型不支持蒙版编辑");
  const abort = signal ? AbortSignal.any([signal, AbortSignal.timeout(IMAGE_GENERATION_TIMEOUT_MS)]) : AbortSignal.timeout(IMAGE_GENERATION_TIMEOUT_MS);
  const gemini = input.model === "gemini-3.1-flash-image";
  let body: BodyInit;
  if (gemini) {
    body = JSON.stringify({ contents: [{ role: "user", parts: [{ text: input.prompt },
      { inlineData: { mimeType: "image/png", data: image.toString("base64") } }] }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"], ...(input.aspect_ratio ? { imageConfig: { aspectRatio: input.aspect_ratio } } : {}) } });
  } else {
    const form = new FormData();
    form.set("model", input.model!); form.set("prompt", input.prompt); form.set("n", "1"); form.set("response_format", "b64_json");
    form.set("image", new Blob([new Uint8Array(image)], { type: "image/png" }), "source.png");
    if (mask) form.set("mask", new Blob([new Uint8Array(mask)], { type: "image/png" }), "mask.png");
    if (input.aspect_ratio) form.set("size", { "1:1": "1024x1024", "3:2": "1536x1024", "2:3": "1024x1536" }[input.aspect_ratio]);
    body = form;
  }
  try {
    const response = await request(gemini ? `${base}/v1beta/models/${input.model}:generateContent` : `${base}/v1/images/edits`, {
      method: "POST", redirect: "error", signal: abort, headers: { Authorization: `Bearer ${key}`, ...(gemini ? { "Content-Type": "application/json" } : {}) }, body,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      fail(response.status === 429 ? 503 : 502, `改图服务拒绝请求（HTTP ${response.status}），请检查网关的编辑能力和模型权限；未改用文生图`);
    }
    const result = await generatedImage(await responseJson(response), gemini);
    abort.throwIfAborted();
    return result;
  } catch (error) {
    if (signal?.aborted) return fail(499, "改图已取消，未发布图片");
    if (abort.aborted) return fail(504, "改图超时，结果未确认，请勿自动重试");
    if (error instanceof HttpError) throw error;
    return fail(502, "无法连接改图服务，结果未确认，请勿自动重试");
  }
}
