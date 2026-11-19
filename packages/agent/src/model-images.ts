/** Node-only: originals stay in storage; only these derivatives cross the model boundary. */
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import type { ContextEvent, ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { type ChatImage, MODEL_IMAGE_LONG_SIDE, MODEL_IMAGE_QUALITY, MAX_MODEL_IMAGE_BYTES, MAX_MODEL_IMAGES_BYTES, MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS } from './images.js';

// Byte-bounded LRU; never persist or log image payloads. Hash keys avoid retaining originals.
const cache = new Map<string, ChatImage>();
let cacheBytes = 0;
const CACHE_BYTES = 16 * 1024 * 1024;
export async function compressModelImage(image: ChatImage): Promise<ChatImage> {
  const key = createHash('sha256').update(image.mime_type).update(image.data).digest('hex');
  const cached = cache.get(key);
  if (cached) { cache.delete(key); cache.set(key, cached); return { ...cached, name: image.name }; }
  const input = Buffer.from(image.data, 'base64');
  if (!input.length || input.length > MAX_IMAGE_BYTES) throw new Error('图片原图大小超限');
  try {
    // animated:false deliberately selects frame 0, not a tall strip of GIF frames.
    const pipeline = sharp(input, { animated: false, limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'warning' });
    const metadata = await pipeline.metadata();
    const resized = pipeline.rotate().resize({ width: MODEL_IMAGE_LONG_SIDE, height: MODEL_IMAGE_LONG_SIDE, fit: 'inside', withoutEnlargement: true });
    // Lossless PNG preserves alpha and small text. No white/black background flattening.
    const usePng = metadata.hasAlpha || metadata.format === 'png';
    const output = usePng
      ? await resized.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer()
      // WebP inputs use lossless recompression: crossing server/runner processes
      // or cache eviction must never accumulate another lossy generation.
      : await resized.webp(metadata.format === 'webp' ? { lossless: true, effort: 4 } : { quality: MODEL_IMAGE_QUALITY, smartSubsample: true, effort: 4 }).toBuffer();
    if (output.length > MAX_MODEL_IMAGE_BYTES) throw new Error('压缩副本仍超过 2 MB，请裁剪图片后重试；不会自动继续降低画质');
    const result = { name: image.name, mime_type: usePng ? 'image/png' : 'image/webp', data: output.toString('base64') };
    const remember = (cacheKey: string) => {
      if (cache.has(cacheKey)) return;
      while (cacheBytes + result.data.length > CACHE_BYTES && cache.size) {
        const oldest = cache.keys().next().value!;
        cacheBytes -= cache.get(oldest)!.data.length; cache.delete(oldest);
      }
      cache.set(cacheKey, result); cacheBytes += result.data.length;
    };
    remember(key);
    // Avoid a second lossy encode at the next guard in the same process.
    remember(createHash('sha256').update(result.mime_type).update(result.data).digest('hex'));
    return { ...result };
  } catch (error) {
    throw new Error('图片压缩失败，原图不会发送给模型：' + (error instanceof Error ? error.message : '无法解码图片'));
  }
}
export async function compressModelImages(images: ChatImage[] = []): Promise<ChatImage[]> {
  const result: ChatImage[] = [];
  let bytes = 0;
  for (const image of images) {
    const compressed = await compressModelImage(image);
    bytes += Buffer.from(compressed.data, 'base64').length;
    if (bytes > MAX_MODEL_IMAGES_BYTES) throw new Error('模型图片合计超过 4 MB，请减少图片；不会发送原图');
    result.push(compressed);
  }
  return result;
}

/** Final guard also covers screenshots/tool images and historical tool results. */
export const modelImageExtension: ExtensionFactory = pi => {
  pi.on('context', async event => {
    let total = 0;
    const messages: ContextEvent['messages'] = [];
    // Newest user/tool images have priority; preserve message order in the result.
    for (const message of [...event.messages].reverse()) {
      if (!('content' in message) || !Array.isArray(message.content)) { messages.unshift(message); continue; }
      const content = [];
      for (const part of message.content) {
        if (part.type !== 'image') { content.push(part); continue; }
        try {
          const image = await compressModelImage({ name: 'model-image', mime_type: part.mimeType, data: part.data });
          const size = Buffer.from(image.data, 'base64').length;
          if (total + size > MAX_MODEL_IMAGES_BYTES) throw new Error('模型上下文图片超过 4 MB，请减少图片或开启新对话');
          total += size;
          content.push({ type: 'image' as const, mimeType: image.mime_type, data: image.data });
        } catch {
          // Extension exceptions are swallowed by Pi: replace with an explicit omission,
          // never throw here and accidentally let the unmodified original through.
          content.push({ type: 'text' as const, text: '[图片未提供给模型：压缩失败或图片预算超限，请告知用户并请求裁剪/减少图片，不能推断图片内容。]' });
        }
      }
      messages.unshift({ ...message, content } as typeof message);
    }
    return { messages };
  });
};
