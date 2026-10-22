/** Shared wire format; keep this module usable in the browser. */
export interface ChatImage { name: string; mime_type: string; data: string }
export interface MessageImage { id: string; name: string; mime_type: string }
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGES_BYTES = 4 * 1024 * 1024;
export const IMAGE_LIMIT_HINT = '最多 4 张图片，单张不超过 2 MB，合计不超过 4 MB；支持 JPEG、PNG、WebP、GIF';
export const imageBytes = (image: ChatImage) => image.data.length * 3 / 4 - (image.data.endsWith('==') ? 2 : image.data.endsWith('=') ? 1 : 0);
export function isChatImage(value: unknown): value is ChatImage {
  if (!value || typeof value !== 'object') return false;
  const i = value as ChatImage;
  if (typeof i.name !== 'string' || !i.name.trim() || i.name.length > 255 || !IMAGE_TYPES.includes(i.mime_type as typeof IMAGE_TYPES[number]) || typeof i.data !== 'string') return false;
  if (!i.data.length || i.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || (i.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(i.data)) || imageBytes(i) > MAX_IMAGE_BYTES) return false;
  // Check the file signature as well as the claimed MIME type.
  const bytes = atob(i.data.slice(0, 16));
  return i.mime_type === 'image/png' ? bytes.startsWith('\x89PNG\r\n\x1a\n')
    : i.mime_type === 'image/jpeg' ? bytes.startsWith('\xff\xd8\xff')
    : i.mime_type === 'image/gif' ? /^GIF8[79]a/.test(bytes)
    : bytes.startsWith('RIFF') && bytes.slice(8, 12) === 'WEBP';
}
export function validImages(value: unknown): value is ChatImage[] {
  return Array.isArray(value) && value.length <= MAX_IMAGES && value.every(isChatImage) && value.reduce((n, i) => n + imageBytes(i), 0) <= MAX_IMAGES_BYTES;
}
export const imageSource = (image: ChatImage) => `data:${image.mime_type};base64,${image.data}`;
export const modelImages = (images: ChatImage[] = []) => images.map(image => ({ type: 'image' as const, mimeType: image.mime_type, data: image.data }));
