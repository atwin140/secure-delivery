import { concat, num, utf8, type Sink } from "./bytes";
import type { Entry } from "./package";
const table = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  table[n] = c;
}
const u16 = (n: number) => num(n, 2, true),
  u32 = (n: number) => num(n, 4, true);
export class ZipWriter {
  private offset = 0;
  private directory: Uint8Array[] = [];
  private crc = 0xffffffff;
  private start = 0;
  constructor(private sink: Sink) {}
  private async write(b: Uint8Array) {
    await this.sink.write(b);
    this.offset += b.length;
  }
  async file(
    e: Entry,
    _i: number,
    b: Uint8Array,
    first: boolean,
    last: boolean,
  ) {
    const name = utf8.encode(e.name);
    if (first) {
      this.start = this.offset;
      this.crc = 0xffffffff;
      await this.write(
        concat(
          u32(0x04034b50),
          u16(20),
          u16(0x808),
          u16(0),
          u16(0),
          u16(33),
          u32(0),
          u32(0),
          u32(0),
          u16(name.length),
          u16(0),
          name,
        ),
      );
    }
    for (const byte of b)
      this.crc = table[(this.crc ^ byte) & 255] ^ (this.crc >>> 8);
    await this.write(b);
    if (last) {
      const crc = (this.crc ^ 0xffffffff) >>> 0;
      await this.write(
        concat(u32(0x08074b50), u32(crc), u32(e.size), u32(e.size)),
      );
      this.directory.push(
        concat(
          u32(0x02014b50),
          u16(20),
          u16(20),
          u16(0x808),
          u16(0),
          u16(0),
          u16(33),
          u32(crc),
          u32(e.size),
          u32(e.size),
          u16(name.length),
          u16(0),
          u16(0),
          u16(0),
          u16(0),
          u32(0),
          u32(this.start),
          name,
        ),
      );
    }
  }
  async finish() {
    const start = this.offset;
    for (const d of this.directory) await this.write(d);
    const size = this.offset - start;
    await this.write(
      concat(
        u32(0x06054b50),
        u16(0),
        u16(0),
        u16(this.directory.length),
        u16(this.directory.length),
        u32(size),
        u32(start),
        u16(0),
      ),
    );
  }
}
