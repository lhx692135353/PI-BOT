import {test} from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {replayModelImages} from '../src/images.js';
test('corrupt legacy history omits only the image, never blocks the next text turn', async () => {
  const original = {content:'history text', images:[{name:'legacy.png',mime_type:'image/png',data:'broken'}]};
  const result = await replayModelImages(original);
  assert.deepEqual(result.images, []);
  assert.match(result.content,/history text/);
  assert.match(result.content,/历史图片未提供/);
  assert.equal(original.images[0].data,'broken');
});
test('history derivative never mutates the original download payload', async () => {
  const data = (await sharp({create:{width:2000,height:500,channels:3,background:'red'}}).png().toBuffer()).toString('base64');
  const original = {content:'look',images:[{name:'large.png',mime_type:'image/png',data}]};
  const result = await replayModelImages(original);
  assert.notEqual(result.images![0].data,data);
  assert.equal(original.images[0].data,data);
});
