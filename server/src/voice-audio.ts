/** Stateful PCM16 mono conversion; preserves fractional position across WS chunks. */
export class PcmResampler {
  private tail = Buffer.alloc(0);
  private position = 0;
  constructor(private from: number, private to: number) {}
  convert(chunk: Buffer): Buffer {
    const input = Buffer.concat([this.tail, chunk]);
    const samples = Math.floor(input.length / 2);
    const values: number[] = [];
    while (this.position + 1 < samples) {
      const i = Math.floor(this.position), fraction = this.position - i;
      const a = input.readInt16LE(i * 2), b = input.readInt16LE((i + 1) * 2);
      values.push(Math.round(a + (b - a) * fraction));
      this.position += this.from / this.to;
    }
    const consumed = Math.min(Math.floor(this.position), samples);
    this.tail = Buffer.from(input.subarray(consumed * 2));
    this.position -= consumed;
    const output = Buffer.alloc(values.length * 2);
    values.forEach((sample, i) => output.writeInt16LE(sample, i * 2));
    return output;
  }
}
