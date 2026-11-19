import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { compressModelImage, compressModelImages, modelImageExtension } from '../src/model-images.js';
import { MAX_IMAGE_PIXELS, MODEL_IMAGE_LONG_SIDE } from '../src/images.js';
const payload = (data: Buffer, mime_type = 'image/png') => ({name:'original.png', mime_type, data:data.toString('base64')});

test('large originals are unchanged; model WebP is bounded and metadata stripped', async () => {
  const original = payload(await sharp({create:{width:4200,height:2800,channels:3,background:'#38aef0'}}).jpeg().withMetadata().toBuffer(), 'image/jpeg');
  const before = {...original};
  const result = await compressModelImage(original);
  assert.deepEqual(original, before);
  assert.notEqual(result.data, original.data);
  const meta = await sharp(Buffer.from(result.data,'base64')).metadata();
  assert.equal(meta.width, MODEL_IMAGE_LONG_SIDE);
  assert.ok(meta.height! <= MODEL_IMAGE_LONG_SIDE);
  assert.equal(meta.format, 'webp');
  assert.equal(meta.exif, undefined);
  assert.ok(Buffer.from(result.data,'base64').length < 1024 * 1024);
  assert.deepEqual(await compressModelImage(result), result, 'no lossy second pass');
});
test('small transparent PNG retains exact pixels and alpha, never enlarges', async () => {
  const raw = Buffer.from([255,0,0,0, 0,255,0,128, 0,0,255,255, 0,0,0,255]);
  const original = payload(await sharp(raw,{raw:{width:2,height:2,channels:4}}).png().toBuffer());
  const output = await compressModelImage(original);
  assert.equal(output.mime_type,'image/png');
  assert.deepEqual(await sharp(Buffer.from(output.data,'base64')).raw().toBuffer(), raw);
});
test('GIF uses frame zero, original animation stays intact', async () => {
  const input = await sharp({create:{width:12,height:24,channels:4,background:'#cc0011'}}).raw().toBuffer();
  input.fill(0, input.length / 2);
  const gif = await sharp(input,{raw:{width:12,height:24,channels:4,pageHeight:12}}).gif({delay:[100,100],loop:0}).toBuffer();
  const original = payload(gif,'image/gif');
  assert.equal((await sharp(gif,{animated:true}).metadata()).pages,2);
  const output = await compressModelImage(original);
  const meta = await sharp(Buffer.from(output.data,'base64')).metadata();
  assert.equal(meta.height,12);
  assert.equal(meta.pages,undefined);
  assert.equal(original.data,gif.toString('base64'));
});
test('orientation corrected before resize', async () => {
  const original = payload(await sharp({create:{width:200,height:100,channels:3,background:'red'}}).jpeg().withMetadata({orientation:6}).toBuffer(),'image/jpeg');
  const meta = await sharp(Buffer.from((await compressModelImage(original)).data,'base64')).metadata();
  assert.equal(meta.width,100); assert.equal(meta.height,200); assert.equal(meta.orientation,undefined);
});
test('corrupt and decompression-bomb images fail closed', async () => {
  await assert.rejects(compressModelImage(payload(Buffer.from('not an image'))), /原图不会发送/);
  const image = await sharp({create:{width:Math.ceil(Math.sqrt(MAX_IMAGE_PIXELS))+1,height:Math.ceil(Math.sqrt(MAX_IMAGE_PIXELS))+1,channels:3,background:'white'}}).png().toBuffer();
  await assert.rejects(compressModelImage(payload(image)), /原图不会发送/);
  assert.deepEqual(await compressModelImages(),[]);
});
test('context boundary compresses tool/history images and never leaks on decode failure', async () => {
  let handler:any;
  modelImageExtension({on:(name:string,fn:any)=>{assert.equal(name,'context');handler=fn;}} as any);
  const original = payload(await sharp({create:{width:2000,height:1000,channels:3,background:'red'}}).png().toBuffer());
  const messages = [{role:'toolResult',content:[{type:'image',mimeType:original.mime_type,data:original.data},{type:'image',mimeType:'image/png',data:'broken'}]}];
  const result = await handler({messages});
  assert.notEqual(result.messages[0].content[0].data,original.data);
  assert.equal(result.messages[0].content[1].type,'text');
  assert.match(result.messages[0].content[1].text,/图片未提供/);
  assert.equal(messages[0].content[1].data,'broken');
});

test('already compressed WebP preserves decoded pixels across fresh processes', async () => {
  const {execFileSync} = await import('node:child_process');
  const input = payload(await sharp({create:{width:128,height:64,channels:3,background:'#548ace'}}).jpeg().toBuffer(),'image/jpeg');
  const first = await compressModelImage(input);
  const script = "import {compressModelImage} from './packages/agent/src/model-images.ts'; let data=''; for await (const chunk of process.stdin) data+=chunk; console.log(JSON.stringify(await compressModelImage(JSON.parse(data))));";
  const second = JSON.parse(execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',script],{input:JSON.stringify(first),encoding:'utf8'}));
  assert.deepEqual(await sharp(Buffer.from(first.data,'base64')).raw().toBuffer(), await sharp(Buffer.from(second.data,'base64')).raw().toBuffer());
});
test('GIF first frame is recognizable, not blank', async () => {
  const input = await sharp({create:{width:8,height:8,channels:3,background:'#ff0000'}}).gif().toBuffer();
  const result = await compressModelImage(payload(input,'image/gif'));
  const stats = await sharp(Buffer.from(result.data,'base64')).stats();
  assert.ok(stats.channels[0].mean > 240);
  assert.ok(stats.channels[1].mean < 20);
});
