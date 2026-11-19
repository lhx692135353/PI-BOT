import { z } from 'zod';
import { type ChatImage, IMAGE_TYPES, IMAGE_LIMIT_HINT, MAX_IMAGES, MAX_IMAGE_BYTES, validImages } from '@pi-bot/agent/images';

export const imagesSchema = z.array(z.object({
  name: z.string().trim().min(1).max(255),
  mime_type: z.enum(IMAGE_TYPES),
  data: z.string().min(1).max(Math.ceil(MAX_IMAGE_BYTES / 3) * 4),
})).max(MAX_IMAGES).refine(validImages, IMAGE_LIMIT_HINT);

/** Shared by cloud and desktop RunContext construction; never mutate stored originals. */
export { compressModelImages } from '../../packages/agent/src/model-images.js';
import { compressModelImages } from '../../packages/agent/src/model-images.js';
export async function replayModelImages<T extends { images?: ChatImage[]; content?: string }>(message: T): Promise<T> {
  try { return { ...message, images: await compressModelImages(message.images ?? []) }; }
  catch { return { ...message, images: [], content: (message.content ?? '') + '\n[历史图片未提供给模型：无法安全压缩，请勿推断图片内容。]' }; }
}
