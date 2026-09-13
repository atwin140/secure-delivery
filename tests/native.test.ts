import { it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
const native = createRequire(import.meta.url)("sodium-native");
it("native libsodium independently opens the frozen bundle and secretstream record", async () => {
  const f = JSON.parse(
    await readFile(new URL("./fixtures/golden.json", import.meta.url), "utf8"),
  );
  const b = Buffer.from(f.bundle.slice(5), "base64url"),
    h = b.subarray(0, 64),
    nonce = h.subarray(40),
    ct = b.subarray(64, 112),
    ad = Buffer.concat([Buffer.from("SecureDelivery/Bundle/v1"), h]);
  const master = Buffer.alloc(32),
    w = Buffer.alloc(32),
    key = Buffer.alloc(32);
  native.crypto_pwhash(
    master,
    Buffer.from(f.password),
    h.subarray(24, 40),
    3,
    67108864,
    native.crypto_pwhash_ALG_ARGON2ID13,
  );
  native.crypto_kdf_derive_from_key(w, 1, Buffer.from("SDBNDL01"), master);
  expect(
    native.crypto_auth_verify(
      b.subarray(112),
      Buffer.concat([nonce, ct, ad]),
      w,
    ),
  ).toBe(true);
  native.crypto_aead_xchacha20poly1305_ietf_decrypt(
    key,
    null,
    ct,
    ad,
    nonce,
    w,
  );
  expect(key.toString("hex")).toBe(f.keyHex);
  const p = Buffer.from(f.package, "base64"),
    header = p.subarray(0, 48),
    len = p.readUInt32BE(48),
    mac = p.subarray(52, 84),
    record = p.subarray(84);
  expect(record.length).toBe(len);
  const streamKey = Buffer.alloc(32),
    commitKey = Buffer.alloc(32);
  native.crypto_kdf_derive_from_key(streamKey, 1, Buffer.from("SDPKG001"), key);
  native.crypto_kdf_derive_from_key(commitKey, 2, Buffer.from("SDPKG001"), key);
  const aad = Buffer.concat([header, Buffer.alloc(4), p.subarray(48, 52)]);
  expect(
    native.crypto_auth_verify(
      mac,
      Buffer.concat([header.subarray(24), record, aad]),
      commitKey,
    ),
  ).toBe(true);
  const state = Buffer.alloc(
      native.crypto_secretstream_xchacha20poly1305_STATEBYTES,
    ),
    plaintext = Buffer.alloc(len - 17),
    tag = Buffer.alloc(1);
  native.crypto_secretstream_xchacha20poly1305_init_pull(
    state,
    header.subarray(24),
    streamKey,
  );
  native.crypto_secretstream_xchacha20poly1305_pull(
    state,
    plaintext,
    tag,
    record,
    aad,
  );
  expect(tag[0]).toBe(native.crypto_secretstream_xchacha20poly1305_TAG_FINAL);
  expect(plaintext.includes(Buffer.from("PLAINTEXT-CANARY-4f67"))).toBe(true);
});
