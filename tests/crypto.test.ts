import { describe, it, expect, beforeAll } from "vitest";
import sodium from "libsodium-wrappers-sumo";
import AdmZip from "adm-zip";
import { readFile } from "node:fs/promises";
import {
  ready,
  wrapWithSalt,
  unwrapKey,
  passwordBytes,
  suggestedPassword,
} from "../src/crypto/bundle";
import {
  encryptPackage,
  verifyPackage,
  outputPackage,
  manifest,
  parsePlain,
  validEntries,
  type InputFile,
} from "../src/crypto/package";
import {
  concat,
  utf8,
  MiB,
  num,
  unhex,
  type Source,
} from "../src/crypto/bytes";
import { ZipWriter } from "../src/crypto/zip";
const repo = "00112233445566778899aabbccddeeff",
  key = Uint8Array.from({ length: 32 }, (_, i) => i),
  password = "SYNTHETIC password canary 42";
const source = (bytes: Uint8Array): Source =>
  (async function* () {
    for (let p = 0; p < bytes.length; p += 9173)
      yield bytes.subarray(p, p + 9173);
  })();
const file = (name: string, bytes: Uint8Array): InputFile => ({
  name,
  mime: "application/octet-stream",
  size: bytes.length,
  stream: () => source(bytes),
});
const files = [
  file("filename-canary.txt", utf8.encode("PLAINTEXT-CANARY-4f67")),
  file("empty.txt", new Uint8Array()),
];
async function encrypt(fs = files) {
  const chunks: Uint8Array[] = [];
  await encryptPackage(repo, key, fs, {
    write: async (b) => {
      chunks.push(b.slice());
    },
  });
  return concat(...chunks);
}
beforeAll(() => ready);
describe("bundle fixed profile", () => {
  it("matches frozen fixture and unwraps", async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL("./fixtures/golden.json", import.meta.url),
        "utf8",
      ),
    );
    const bundle = wrapWithSalt(
      repo,
      key,
      password,
      Uint8Array.from({ length: 16 }, (_, i) => i + 32),
      Uint8Array.from({ length: 24 }, (_, i) => i + 48),
    );
    expect(bundle).toBe(fixture.bundle);
    expect(unwrapKey(repo, bundle, password)).toEqual(key);
  });
  it("rejects malformed, oversized and mismatched input before KDF", () => {
    for (const b of [
      "",
      "sdb1." + "a".repeat(193),
      "sdb2." + "a".repeat(192),
      "sdb1." + "=".repeat(192),
    ])
      expect(() => unwrapKey(repo, b, password)).toThrow();
    expect(() => passwordBytes("x".repeat(1025))).toThrow();
    expect(() => passwordBytes("short")).toThrow();
    expect(() => passwordBytes("\ud800".repeat(16))).toThrow();
  });
  it("preserves spaces/case, normalizes NFC, counts code points", () => {
    expect(passwordBytes(" éééééééééééééé ")).toEqual(
      passwordBytes(
        " e\u0301e\u0301e\u0301e\u0301e\u0301e\u0301e\u0301e\u0301e\u0301e\u0301e\u0301e\u0301e\u0301e\u0301 ",
      ),
    );
    expect(() => passwordBytes("😀".repeat(14))).toThrow();
    expect(passwordBytes("😀".repeat(15)).length).toBe(60);
    expect(suggestedPassword()).toMatch(/^[A-Za-z0-9_-]{27}$/);
  });
  it("rejects wrong password/repository and modified authenticated bundle", async () => {
    const f = JSON.parse(
      await readFile(
        new URL("./fixtures/golden.json", import.meta.url),
        "utf8",
      ),
    );
    expect(() => unwrapKey(repo, f.bundle, "WRONG password canary")).toThrow();
    expect(() => unwrapKey("11".repeat(16), f.bundle, password)).toThrow();
    const raw = sodium.from_base64(
      f.bundle.slice(5),
      sodium.base64_variants.URLSAFE_NO_PADDING,
    );
    for (const at of [0, 25, 41, 70, 143]) {
      const b = raw.slice();
      b[at] ^= 1;
      expect(() =>
        unwrapKey(
          repo,
          "sdb1." +
            sodium.to_base64(b, sodium.base64_variants.URLSAFE_NO_PADDING),
          password,
        ),
      ).toThrow();
    }
  });
});
describe("package", () => {
  it("fully verifies then writes individual files and interoperable ZIP", async () => {
    const bytes = await encrypt();
    const verified = await verifyPackage(repo, key, source(bytes));
    expect(verified.entries).toEqual(files.map(({ stream, ...f }) => f));
    const out: Uint8Array[] = [];
    const zip = new ZipWriter({
      write: async (b) => {
        out.push(b.slice());
      },
    });
    await outputPackage(repo, key, source(bytes), verified, zip.file.bind(zip));
    await zip.finish();
    const archive = new AdmZip(Buffer.from(concat(...out)));
    expect(archive.getEntries().map((e) => e.entryName)).toEqual(
      files.map((f) => f.name),
    );
    expect(archive.readAsText("filename-canary.txt")).toBe(
      "PLAINTEXT-CANARY-4f67",
    );
    expect(Buffer.from(bytes).includes(Buffer.from("filename-canary"))).toBe(
      false,
    );
    expect(Buffer.from(bytes).includes(Buffer.from("PLAINTEXT-CANARY"))).toBe(
      false,
    );
  });
  it("reads a frozen package fixture", async () => {
    const f = JSON.parse(
      await readFile(
        new URL("./fixtures/golden.json", import.meta.url),
        "utf8",
      ),
    );
    const v = await verifyPackage(
      repo,
      key,
      source(sodium.from_base64(f.package, sodium.base64_variants.ORIGINAL)),
    );
    expect(v.entries[0].name).toBe("filename-canary.txt");
  });
  it("spans file boundaries using full 1 MiB records and final", async () => {
    const bytes = await encrypt([
      file("a", new Uint8Array(MiB)),
      file("b", new Uint8Array(MiB)),
    ]);
    const v = await verifyPackage(repo, key, source(bytes));
    expect(v.hashes.length).toBe(3);
    expect(v.bytes).toBe(bytes.length);
  });
  it("rejects tampering, wrong key, truncation, trailing/reordered/duplicate records", async () => {
    const bytes = await encrypt([file("a", new Uint8Array(2 * MiB))]);
    const n = 4 + 32 + MiB + 17;
    const invalid = [
      bytes.subarray(0, -1),
      concat(bytes, new Uint8Array([0])),
      concat(
        bytes.subarray(0, 48),
        bytes.subarray(48 + n, 48 + 2 * n),
        bytes.subarray(48, 48 + n),
        bytes.subarray(48 + 2 * n),
      ),
      concat(bytes.subarray(0, 48 + n), bytes.subarray(48)),
    ];
    for (const at of [0, 9, 30, 49, 90, bytes.length - 1]) {
      const b = bytes.slice();
      b[at] ^= 1;
      invalid.push(b);
    }
    for (const b of invalid)
      await expect(verifyPackage(repo, key, source(b))).rejects.toThrow();
    await expect(
      verifyPackage(repo, new Uint8Array(32), source(bytes)),
    ).rejects.toThrow();
  });
  it("does not authorize outputs on late corruption; detects local replacement before that record output", async () => {
    const bytes = await encrypt([file("a", new Uint8Array(MiB + 300))]);
    const bad = bytes.slice();
    bad[bad.length - 1] ^= 1;
    await expect(verifyPackage(repo, key, source(bad))).rejects.toThrow();
    const v = await verifyPackage(repo, key, source(bytes));
    let written = 0;
    await expect(
      outputPackage(repo, key, source(bad), v, async (_e, _i, b) => {
        written += b.length;
      }),
    ).rejects.toThrow();
    expect(written).toBeLessThan(MiB + 300);
  });
  it("rejects bad paths, duplicates, MIME and sizes", () => {
    for (const name of [
      "../a",
      "a/b",
      "a\\b",
      "CON.txt",
      "nul",
      "a:foo",
      "a.",
      "a\u202eb",
      "",
    ])
      expect(() => manifest([file(name, new Uint8Array())])).toThrow();
    expect(() =>
      validEntries([
        { name: "a", mime: "text/plain", size: 0 },
        { name: "A", mime: "text/plain", size: 0 },
      ]),
    ).toThrow();
    expect(() =>
      validEntries([{ name: "a", mime: "text/html; x=1", size: 0 }]),
    ).toThrow();
    expect(() =>
      validEntries([{ name: "a", mime: "text/plain", size: 250 * MiB + 1 }]),
    ).toThrow();
    expect(() => manifest(Array(101).fill(files[0]))).toThrow();
  });
  it("rejects validly encrypted malformed internal structure and trailing plaintext", async () => {
    for (const plain of [
      concat(utf8.encode("SDFIL001"), num(101, 2)),
      concat(manifest(files), utf8.encode("short")),
      concat(manifest([file("a", new Uint8Array())]), new Uint8Array([1])),
    ]) {
      const sk = sodium.crypto_kdf_derive_from_key(32, 1, "SDPKG001", key),
        ck = sodium.crypto_kdf_derive_from_key(32, 2, "SDPKG001", key),
        s = sodium.crypto_secretstream_xchacha20poly1305_init_push(sk);
      const h = concat(utf8.encode("SDPKG001"), unhex(repo), s.header),
        l = num(plain.length + 17),
        ad = concat(h, num(0), l),
        ct = sodium.crypto_secretstream_xchacha20poly1305_push(
          s.state,
          plain,
          ad,
          3,
        );
      const encrypted = concat(
        h,
        l,
        sodium.crypto_auth(concat(s.header, ct, ad), ck),
        ct,
      );
      await expect(
        verifyPackage(repo, key, source(encrypted)),
      ).rejects.toThrow();
      await expect(parsePlain(source(plain))).rejects.toThrow();
    }
  });
});
