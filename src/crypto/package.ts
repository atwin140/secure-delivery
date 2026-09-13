import sodium from "libsodium-wrappers-sumo";
import {
  concat,
  equal,
  utf8,
  unhex,
  num,
  value,
  Reader,
  fail,
  MiB,
  MAX_FILE,
  MAX_TOTAL,
  MAX_CIPHER,
  fromBlob,
  type Source,
  type Sink,
} from "./bytes";
export type Entry = { name: string; mime: string; size: number };
export type InputFile = Entry & { stream: () => Source };
export type Verified = {
  entries: Entry[];
  header: Uint8Array;
  hashes: Uint8Array[];
  bytes: number;
};
const decoder = new TextDecoder("utf-8", { fatal: true });
const magic = utf8.encode("SDFIL001");
export function validName(name: string) {
  if (
    !name.isWellFormed() ||
    name !== name.normalize("NFC") ||
    !name ||
    utf8.encode(name).length > 240 ||
    /[\/\\:<>"|?*\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(name) ||
    /[. ]$/.test(name) ||
    /^\.{1,2}$/.test(name) ||
    /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)
  )
    fail();
}
export function validEntries(entries: Entry[]) {
  if (!entries.length || entries.length > 100) fail();
  let size = 0;
  const seen = new Set<string>();
  for (const e of entries) {
    validName(e.name);
    const folded = e.name.toLowerCase();
    if (seen.has(folded)) fail();
    seen.add(folded);
    if (
      !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(e.mime) ||
      e.mime.length > 127 ||
      !Number.isSafeInteger(e.size) ||
      e.size < 0 ||
      e.size > MAX_FILE
    )
      fail();
    size += e.size;
  }
  if (size > MAX_TOTAL) fail();
}
export function manifest(entries: Entry[]) {
  validEntries(entries);
  return concat(
    magic,
    num(entries.length, 2),
    ...entries.map((e) => {
      const name = utf8.encode(e.name),
        mime = utf8.encode(e.mime);
      return concat(
        num(name.length, 2),
        name,
        num(mime.length, 2),
        mime,
        num(e.size, 8),
      );
    }),
  );
}
export function fileInput(f: File): InputFile {
  return {
    name: f.name.normalize("NFC"),
    mime:
      /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(f.type) &&
      f.type.length <= 127
        ? f.type
        : "application/octet-stream",
    size: f.size,
    stream: () => fromBlob(f),
  };
}
async function* plaintext(files: InputFile[]): Source {
  yield manifest(files);
  for (const f of files) {
    let n = 0;
    for await (const b of f.stream()) {
      n += b.length;
      if (n > f.size) fail();
      yield b;
    }
    if (n !== f.size) fail();
  }
}
export async function encryptPackage(
  repo: string,
  key: Uint8Array,
  files: InputFile[],
  sink: Sink,
  progress = (n: number) => {},
) {
  validEntries(files);
  const k = sodium.crypto_kdf_derive_from_key(32, 1, "SDPKG001", key),
    c = sodium.crypto_kdf_derive_from_key(32, 2, "SDPKG001", key);
  const { state, header } =
    sodium.crypto_secretstream_xchacha20poly1305_init_push(k);
  const h = concat(utf8.encode("SDPKG001"), unhex(repo), header);
  let count = 0,
    index = 0,
    used = 0;
  const buffer = new Uint8Array(MiB);
  const hash = sodium.crypto_hash_sha256_init();
  const write = async (b: Uint8Array) => {
    count += b.length;
    if (count > MAX_CIPHER) fail();
    sodium.crypto_hash_sha256_update(hash, b);
    await sink.write(b);
    progress(count);
  };
  const record = async (final: boolean) => {
    const l = used + 17,
      ad = concat(h, num(index++), num(l));
    const ct = sodium.crypto_secretstream_xchacha20poly1305_push(
      state,
      buffer.subarray(0, used),
      ad,
      final
        ? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
        : sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE,
    );
    await write(
      concat(num(l), sodium.crypto_auth(concat(header, ct, ad), c), ct),
    );
    used = 0;
  };
  try {
    await write(h);
    for await (const b of plaintext(files)) {
      let p = 0;
      while (p < b.length) {
        const n = Math.min(MiB - used, b.length - p);
        buffer.set(b.subarray(p, p + n), used);
        p += n;
        used += n;
        if (used === MiB) await record(false);
      }
    }
    await record(true);
    return {
      bytes: count,
      digest: sodium.to_hex(sodium.crypto_hash_sha256_final(hash)),
    };
  } finally {
    sodium.memzero(k);
    sodium.memzero(c);
    sodium.memzero(buffer);
  }
}
type State = { header?: Uint8Array; hashes: Uint8Array[]; bytes: number };
async function* decrypt(
  repo: string,
  key: Uint8Array,
  source: Source,
  info: State,
  verified?: Verified,
): Source {
  const r = new Reader(source);
  const h = await r.read(48);
  if (
    !equal(h.subarray(0, 8), utf8.encode("SDPKG001")) ||
    !equal(h.subarray(8, 24), unhex(repo)) ||
    (verified && !equal(h, verified.header))
  )
    fail();
  info.header = h;
  info.bytes = 48;
  const k = sodium.crypto_kdf_derive_from_key(32, 1, "SDPKG001", key),
    c = sodium.crypto_kdf_derive_from_key(32, 2, "SDPKG001", key);
  let i = 0;
  try {
    const state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(
      h.subarray(24),
      k,
    );
    for (;;) {
      if (i >= 1025) fail();
      const lb = await r.read(4),
        l = value(lb);
      if (l < 17 || l > MiB + 17) fail();
      const mac = await r.read(32),
        ct = await r.read(l),
        bytes = concat(lb, mac, ct);
      info.bytes += bytes.length;
      if (info.bytes > MAX_CIPHER) fail();
      const hash = sodium.crypto_hash_sha256(bytes);
      if (verified && (!verified.hashes[i] || !equal(hash, verified.hashes[i])))
        fail();
      info.hashes.push(hash);
      const ad = concat(h, num(i++), lb);
      if (!sodium.crypto_auth_verify(mac, concat(h.subarray(24), ct, ad), c))
        fail();
      const result = sodium.crypto_secretstream_xchacha20poly1305_pull(
        state,
        ct,
        ad,
      );
      if (!result) fail();
      const final =
        result.tag === sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL;
      if (
        final
          ? result.message.length >= MiB
          : result.tag !==
              sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE ||
            result.message.length !== MiB
      )
        fail();
      try {
        yield result.message;
      } finally {
        sodium.memzero(result.message);
      }
      if (final) {
        await r.eof();
        if (
          verified &&
          (verified.hashes.length !== i || verified.bytes !== info.bytes)
        )
          fail();
        break;
      }
    }
  } finally {
    sodium.memzero(k);
    sodium.memzero(c);
  }
}
export async function parsePlain(
  source: Source,
  onFile?: (
    entry: Entry,
    index: number,
    chunk: Uint8Array,
    first: boolean,
    last: boolean,
  ) => Promise<void>,
) {
  const r = new Reader(source);
  if (!equal(await r.read(8), magic)) fail();
  const count = value(await r.read(2));
  if (count < 1 || count > 100) fail();
  const entries: Entry[] = [];
  for (let i = 0; i < count; i++) {
    const nl = value(await r.read(2));
    if (nl < 1 || nl > 240) fail();
    const name = decoder.decode(await r.read(nl));
    const ml = value(await r.read(2));
    if (ml < 1 || ml > 127) fail();
    const mime = decoder.decode(await r.read(ml)),
      size = value(await r.read(8));
    entries.push({ name, mime, size });
  }
  validEntries(entries);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    let left = e.size,
      first = true;
    do {
      const b = await r.read(Math.min(MiB, left));
      left -= b.length;
      try {
        if (onFile) await onFile(e, i, b, first, left === 0);
      } finally {
        sodium.memzero(b);
      }
      first = false;
    } while (left > 0);
  }
  await r.eof();
  return entries;
}
export async function verifyPackage(
  repo: string,
  key: Uint8Array,
  source: Source,
  progress = (n: number) => {},
) {
  const info: State = { hashes: [], bytes: 0 };
  const entries = await parsePlain(decrypt(repo, key, source, info), async () =>
    progress(info.bytes),
  );
  return {
    entries,
    header: info.header!,
    hashes: info.hashes,
    bytes: info.bytes,
  };
}
export async function outputPackage(
  repo: string,
  key: Uint8Array,
  source: Source,
  verified: Verified,
  onFile: Parameters<typeof parsePlain>[1],
) {
  const info: State = { hashes: [], bytes: 0 };
  const entries = await parsePlain(
    decrypt(repo, key, source, info, verified),
    onFile,
  );
  if (!equal(manifest(entries), manifest(verified.entries))) fail();
}
