import sodium from "libsodium-wrappers-sumo";
import { concat, equal, utf8, unhex, fail } from "./bytes";
export const ready = sodium.ready;
const domain = utf8.encode("SecureDelivery/Bundle/v1");
export function passwordBytes(input: string) {
  if (input.length > 4096 || !input.isWellFormed())
    throw new Error("Password must contain valid Unicode.");
  const p = input.normalize("NFC");
  const b = utf8.encode(p);
  if ([...p].length < 15 || b.length > 1024)
    throw new Error(
      "Use at least 15 characters and at most 1024 UTF-8 bytes. Spaces and case are preserved.",
    );
  return b;
}
export function randomKey() {
  return sodium.randombytes_buf(32);
}
export function suggestedPassword() {
  return sodium.to_base64(
    sodium.randombytes_buf(20),
    sodium.base64_variants.URLSAFE_NO_PADDING,
  );
}
function derive(password: string, salt: Uint8Array) {
  const bytes = passwordBytes(password);
  let master: Uint8Array | undefined;
  try {
    master = sodium.crypto_pwhash(
      32,
      bytes,
      salt,
      3,
      67108864,
      sodium.crypto_pwhash_ALG_ARGON2ID13,
    );
    return sodium.crypto_kdf_derive_from_key(32, 1, "SDBNDL01", master);
  } finally {
    sodium.memzero(bytes);
    if (master) sodium.memzero(master);
  }
}
export function wrapKey(repo: string, key: Uint8Array, password: string) {
  if (key.length !== 32) fail();
  const salt = sodium.randombytes_buf(16),
    nonce = sodium.randombytes_buf(24);
  return wrapWithSalt(repo, key, password, salt, nonce);
}
// Explicit fixture entrypoint; production calls wrapKey and cannot supply randomness.
export function wrapWithSalt(
  repo: string,
  key: Uint8Array,
  password: string,
  salt: Uint8Array,
  nonce: Uint8Array,
) {
  if (key.length !== 32 || salt.length !== 16 || nonce.length !== 24) fail();
  const h = concat(utf8.encode("SDKEY001"), unhex(repo), salt, nonce),
    ad = concat(domain, h),
    w = derive(password, salt);
  try {
    const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      key,
      ad,
      null,
      nonce,
      w,
    );
    const mac = sodium.crypto_auth(concat(nonce, ct, ad), w);
    return (
      "sdb1." +
      sodium.to_base64(
        concat(h, ct, mac),
        sodium.base64_variants.URLSAFE_NO_PADDING,
      )
    );
  } finally {
    sodium.memzero(w);
  }
}
export function unwrapKey(repo: string, text: string, password: string) {
  if (text.length !== 197 || !/^sdb1\.[A-Za-z0-9_-]{192}$/.test(text)) fail();
  const all = sodium.from_base64(
    text.slice(5),
    sodium.base64_variants.URLSAFE_NO_PADDING,
  );
  if (
    all.length !== 144 ||
    !equal(all.subarray(0, 8), utf8.encode("SDKEY001")) ||
    !equal(all.subarray(8, 24), unhex(repo))
  )
    fail();
  const h = all.subarray(0, 64),
    nonce = h.subarray(40, 64),
    ct = all.subarray(64, 112),
    ad = concat(domain, h);
  const w = derive(password, h.subarray(24, 40));
  try {
    if (!sodium.crypto_auth_verify(all.subarray(112), concat(nonce, ct, ad), w))
      fail();
    const key = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      ct,
      ad,
      nonce,
      w,
    );
    if (key.length !== 32) fail();
    return key;
  } catch {
    throw new Error(
      "Unable to unlock. Check the bundle, repository and password.",
    );
  } finally {
    sodium.memzero(w);
  }
}
