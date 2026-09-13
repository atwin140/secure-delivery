import { writeFile, mkdir } from "node:fs/promises";
import sodium from "libsodium-wrappers-sumo";
import { wrapWithSalt } from "../src/crypto/bundle";
import { encryptPackage } from "../src/crypto/package";
import { concat, utf8 } from "../src/crypto/bytes";
await sodium.ready;
const repo = "00112233445566778899aabbccddeeff",
  key = Uint8Array.from({ length: 32 }, (_, i) => i),
  password = "SYNTHETIC password canary 42";
const bundle = wrapWithSalt(
  repo,
  key,
  password,
  Uint8Array.from({ length: 16 }, (_, i) => i + 32),
  Uint8Array.from({ length: 24 }, (_, i) => i + 48),
);
const plain = utf8.encode("PLAINTEXT-CANARY-4f67");
const chunks: Uint8Array[] = [];
await encryptPackage(
  repo,
  key,
  [
    {
      name: "filename-canary.txt",
      mime: "application/octet-stream",
      size: plain.length,
      stream: () =>
        (async function* () {
          yield plain;
        })(),
    },
  ],
  {
    write: async (b) => {
      chunks.push(b.slice());
    },
  },
);
await mkdir("tests/fixtures", { recursive: true });
await writeFile(
  "tests/fixtures/golden.json",
  JSON.stringify(
    {
      warning: "SYNTHETIC TEST DATA ONLY. Never production secrets.",
      repo,
      keyHex: sodium.to_hex(key),
      password,
      bundle,
      package: sodium.to_base64(
        concat(...chunks),
        sodium.base64_variants.ORIGINAL,
      ),
    },
    null,
    2,
  ) + "\n",
);
