import { z } from 'zod';
import { IMAGE_TYPES, IMAGE_LIMIT_HINT, MAX_IMAGES, MAX_IMAGE_BYTES, validImages } from '@pi-bot/agent/images';

export const imagesSchema = z.array(z.object({
  name: z.string().trim().min(1).max(255),
  mime_type: z.enum(IMAGE_TYPES),
  data: z.string().min(1).max(Math.ceil(MAX_IMAGE_BYTES / 3) * 4),
})).max(MAX_IMAGES).refine(validImages, IMAGE_LIMIT_HINT);
