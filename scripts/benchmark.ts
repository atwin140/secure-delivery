import { mkdir, open, unlink, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import os from "node:os";
import sodium from "libsodium-wrappers-sumo";
import {
  encryptPackage,
  verifyPackage,
  outputPackage,
  type InputFile,
} from "../src/crypto/package";
import { MiB, type Source } from "../src/crypto/bytes";
import { wrapKey, unwrapKey, suggestedPassword } from "../src/crypto/bundle";
import { ZipWriter } from "../src/crypto/zip";
await sodium.ready;
await mkdir(".local/benchmark", { recursive: true });
const repo = sodium.to_hex(sodium.randombytes_buf(16)),
  key = sodium.randombytes_buf(32),
  password = suggestedPassword();
let peak = process.memoryUsage().rss;
const memory = setInterval(() => {
  peak = Math.max(peak, process.memoryUsage().rss);
}, 10);
const timings: Record<string, number> = {};
const timed = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
  const t = performance.now();
  const result = await fn();
  timings[name] = performance.now() - t;
  return result;
};
const bundle = wrapKey(repo, key, password);
await timed("unlockMs", async () => {
  const k = unwrapKey(repo, bundle, password);
  sodium.memzero(k);
});
const full = process.env.BENCHMARK_SMALL !== "true",
  sizes = full ? [250, 250, 250, 250, 24, ...Array(95).fill(0)] : [8, 8];
const files: InputFile[] = sizes.map((size, i) => ({
  name: String(i).padStart(3, "0") + "x".repeat(237),
  mime: "application/" + "x".repeat(115),
  size: size * MiB,
  stream: () =>
    (async function* () {
      let remaining = size * MiB;
      const b = new Uint8Array(MiB);
      while (remaining) {
        const n = Math.min(remaining, b.length);
        yield b.subarray(0, n);
        remaining -= n;
      }
    })(),
}));
const paths = [
  ".local/benchmark/package.sdp",
  ".local/benchmark/individual.bin",
  ".local/benchmark/all.zip",
];
try {
  const out = await open(paths[0], "w");
  let info;
  try {
    info = await timed("encryptMs", () =>
      encryptPackage(repo, key, files, { write: (b) => out.writeFile(b) }),
    );
  } finally {
    await out.close();
  }
  const source = () =>
    createReadStream(paths[0], { highWaterMark: MiB }) as Source;
  const v = await timed("verifyMs", () => verifyPackage(repo, key, source()));
  const individual = await open(paths[1], "w");
  try {
    await timed("individualOutputMs", () =>
      outputPackage(repo, key, source(), v, async (_e, i, b) => {
        if (i === 0) await individual.writeFile(b);
      }),
    );
  } finally {
    await individual.close();
  }
  const all = await open(paths[2], "w");
  try {
    const zip = new ZipWriter({ write: (b) => all.writeFile(b) });
    await timed("zipOutputMs", async () => {
      await outputPackage(repo, key, source(), v, zip.file.bind(zip));
      await zip.finish();
    });
  } finally {
    await all.close();
  }
  peak = Math.max(peak, process.memoryUsage().rss);
  const result = {
    at: new Date().toISOString(),
    runtime: process.version,
    platform: os.platform(),
    arch: os.arch(),
    cpu: os.cpus()[0]?.model,
    fullSize: full,
    plaintextBytes: files.reduce((n, f) => n + f.size, 0),
    ciphertextBytes: info.bytes,
    files: files.length,
    largestOutputBytes: files[0].size,
    peakProcessRssBytes: peak,
    ...timings,
    interpretation:
      "Node filesystem benchmark, not a browser support claim. Peak RSS includes Node and libsodium WASM.",
  };
  await writeFile(
    "evidence/benchmark-node.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
} finally {
  clearInterval(memory);
  sodium.memzero(key);
  for (const path of paths) await unlink(path).catch(() => {});
}
