import test from "node:test";
import assert from "node:assert/strict";
import { PcmResampler } from "../src/voice-audio.js";
for (const [from,to] of [[16000,24000],[24000,16000]]) {
  test(`PCM ${from} -> ${to} preserves streaming chunks and sample values`, () => {
    const input = Buffer.alloc(from * 2);
    for (let i=0;i<from;i++) input.writeInt16LE(Math.round(10000*Math.sin(i*2*Math.PI*440/from)), i*2);
    const whole = new PcmResampler(from,to).convert(input);
    const stream = new PcmResampler(from,to);
    const chunks: Buffer[]=[];
    // Odd byte lengths cover chunk boundaries inside a PCM16 sample.
    for (let i=0;i<input.length;i+=137) chunks.push(stream.convert(input.subarray(i,i+137)));
    assert.deepEqual(Buffer.concat(chunks),whole);
    assert.ok(Math.abs(whole.length/2-to)<=2);
    for(let i=0;i<whole.length/2;i++) assert.ok(Math.abs(whole.readInt16LE(i*2)-10000*Math.sin(i*2*Math.PI*440/to))<45);
  });
}
