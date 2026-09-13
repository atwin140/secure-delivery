export const MiB = 1048576,
  MAX_FILE = 250 * MiB,
  MAX_TOTAL = 1024 * MiB,
  MAX_CIPHER = 1073834107;
export const utf8 = new TextEncoder();
export function fail(): never {
  throw new Error("Invalid or unsupported encrypted package.");
}
export function concat(...items: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(items.reduce((a, b) => a + b.length, 0));
  let p = 0;
  for (const item of items) {
    out.set(item, p);
    p += item.length;
  }
  return out;
}
export function num(n: number, width = 4, little = false): Uint8Array {
  const b = new Uint8Array(width);
  const d = new DataView(b.buffer);
  if (width === 2) d.setUint16(0, n, little);
  else if (width === 4) d.setUint32(0, n, little);
  else d.setBigUint64(0, BigInt(n), little);
  return b;
}
export function value(b: Uint8Array, little = false): number {
  const d = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return b.length === 2
    ? d.getUint16(0, little)
    : b.length === 4
      ? d.getUint32(0, little)
      : Number(d.getBigUint64(0, little));
}
export function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let n = 0;
  for (let i = 0; i < a.length; i++) n |= a[i] ^ b[i];
  return n === 0;
}
export function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
export function unhex(s: string): Uint8Array {
  if (!/^[a-f0-9]{32}$/.test(s)) fail();
  return Uint8Array.from(s.match(/../g)!, (x) => parseInt(x, 16));
}
export type Source = AsyncIterable<Uint8Array>;
export type Sink = { write: (b: Uint8Array) => Promise<void> };
export async function* fromBlob(blob: Blob): Source {
  for (let p = 0; p < blob.size; p += MiB)
    yield new Uint8Array(await blob.slice(p, p + MiB).arrayBuffer());
}
export class Reader {
  private iterator: AsyncIterator<Uint8Array>;
  private chunk = new Uint8Array(0) as Uint8Array;
  private at = 0;
  ended = false;
  constructor(source: Source) {
    this.iterator = source[Symbol.asyncIterator]();
  }
  async read(n: number, optional = false): Promise<Uint8Array> {
    const out = new Uint8Array(n);
    let p = 0;
    while (p < n) {
      if (this.at === this.chunk.length) {
        const next = await this.iterator.next();
        if (next.done) {
          this.ended = true;
          if (optional && p === 0) return new Uint8Array();
          fail();
        }
        this.chunk = next.value;
        this.at = 0;
        if (!this.chunk.length) continue;
      }
      const take = Math.min(n - p, this.chunk.length - this.at);
      out.set(this.chunk.subarray(this.at, this.at + take), p);
      this.at += take;
      p += take;
    }
    return out;
  }
  async eof() {
    if ((await this.read(1, true)).length) fail();
  }
}
