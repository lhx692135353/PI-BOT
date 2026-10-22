import test from 'node:test';
import assert from 'node:assert/strict';
import { isChatImage, validImages, MAX_IMAGE_BYTES, imageBytes } from '../src/images.js';
import { schemas } from '../../../desktop/packages/protocol/src/index.js';
import { routes } from '../../../server/src/routes.js';
import { messageOut } from '../../../server/src/bots.js';

export const image = { name: 'pixel.png', mime_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC' };

test('image validation checks MIME, signature, base64, count, individual and total size', () => {
  assert.ok(isChatImage(image));
  assert.ok(validImages([image]));
  for (const bad of [null, {}, { ...image, mime_type: 'image/svg+xml' }, { ...image, mime_type: 'image/jpeg' }, { ...image, data: 'not base64' }, { ...image, data: '' }, { ...image, name: '' }]) assert.equal(isChatImage(bad), false);
  assert.equal(validImages(Array(5).fill(image)), false);
  const bytes = Buffer.alloc(MAX_IMAGE_BYTES);
  Buffer.from(image.data, 'base64').copy(bytes);
  const large = { ...image, data: bytes.toString('base64') };
  assert.equal(imageBytes(large), MAX_IMAGE_BYTES);
  assert.ok(validImages([large, large]));
  assert.equal(validImages([large, large, image]), false);
  assert.equal(isChatImage({ ...image, data: Buffer.concat([bytes, Buffer.from([0])]).toString('base64') }), false);
});

test('desktop and HTTP schemas allow image-only messages and reject empty or invalid uploads', () => {
  const http = routes.find(route => route.method === 'POST' && route.path === '/bots/:id/messages')!.body!;
  for (const schema of [http, schemas.send]) {
    const base = { botId: '00000000-0000-4000-8000-000000000001', request_id: '00000000-0000-4000-8000-000000000002' };
    assert.ok(schema.safeParse({ ...base, images: [image] }).success);
    assert.ok(schema.safeParse({ ...base, text: 'hello' }).success);
    assert.equal(schema.safeParse({ ...base, text: '  ', images: [] }).success, false);
    assert.equal(schema.safeParse({ ...base, text: 'hello', images: [{ ...image, mime_type: 'text/html' }] }).success, false);
  }
});

test('timeline messages return only image metadata, keeping payloads bounded', () => {
  const out = messageOut({ images: [{ ...image, id: 'image-id' }] });
  assert.deepEqual(out.images, [{ id: 'image-id', name: image.name, mime_type: image.mime_type }]);
  assert.equal(JSON.stringify(out).includes(image.data), false);
  assert.deepEqual(messageOut({}).images, []);
});
