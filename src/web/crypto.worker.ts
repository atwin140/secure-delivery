/// <reference lib="webworker" />
import sodium from "libsodium-wrappers-sumo";
import {
  ready,
  randomKey,
  suggestedPassword,
  wrapKey,
  unwrapKey,
} from "../crypto/bundle";
import {
  encryptPackage,
  verifyPackage,
  outputPackage,
  fileInput,
  type Verified,
} from "../crypto/package";
import {
  fromBlob,
  MAX_CIPHER,
  MAX_TOTAL,
  MiB,
  type Sink,
} from "../crypto/bytes";
import { ZipWriter } from "../crypto/zip";
const scope = self as unknown as DedicatedWorkerGlobalScope;
let root: FileSystemDirectoryHandle,
  temp: FileSystemFileHandle | undefined,
  tempName = "",
  release: (() => void) | undefined;
let key: Uint8Array | undefined,
  repo = "",
  verified: Verified | undefined,
  cipher: File | undefined,
  controller = new AbortController();
const post = (type: string, data: unknown = {}) =>
  scope.postMessage({ type, ...(data as object) });
let lastProgress = 0;
const progress = (phase: string, bytes: number, total: number) => {
  if (performance.now() - lastProgress > 100 || bytes === total) {
    post("progress", { phase, bytes, total });
    lastProgress = performance.now();
  }
};
async function cleanup() {
  verified = undefined;
  cipher = undefined;
  if (key) sodium.memzero(key);
  key = undefined;
  if (tempName) await root.removeEntry(tempName).catch(() => {});
  temp = undefined;
  tempName = "";
  release?.();
  release = undefined;
}
async function collect() {
  root = await navigator.storage.getDirectory();
  for await (const [name] of (root as any).entries()) {
    if (!/^sd-[a-f0-9-]+$/.test(name)) continue;
    await navigator.locks.request(
      name,
      { mode: "exclusive", ifAvailable: true },
      async (lock) => {
        if (lock) await root.removeEntry(name).catch(() => {});
      },
    );
  }
}
async function localFile(estimate: number, reset = true) {
  if (reset) await cleanup();
  const quota = await navigator.storage.estimate();
  if (
    quota.quota !== undefined &&
    quota.usage !== undefined &&
    quota.quota - quota.usage < estimate + 16 * MiB
  )
    throw new Error(
      "Not enough browser storage. Free space or clear old site data, then retry.",
    );
  tempName = "sd-" + crypto.randomUUID();
  await new Promise<void>((resolve, reject) => {
    void navigator.locks
      .request(tempName, { mode: "exclusive" }, async () => {
        temp = await root.getFileHandle(tempName, { create: true });
        resolve();
        await new Promise<void>((r) => {
          release = r;
        });
      })
      .catch(reject);
  });
  return temp!;
}
async function json(path: string, csrf: string, body: unknown = {}) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-csrf-token": csrf },
    body: JSON.stringify(body),
    signal: controller.signal,
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
  });
  if (!r.ok)
    throw new Error(
      "Delivery could not be completed. Create a new delivery to retry.",
    );
  return r.json();
}
async function send(data: {
  repo: string;
  files: File[];
  password: string;
  csrf: string;
}) {
  repo = data.repo;
  const total = data.files.reduce((n, f) => n + f.size, 0);
  if (total > MAX_TOTAL)
    throw new Error("A delivery can contain at most 1 GiB.");
  const handle = await localFile(total + 100000);
  key = randomKey();
  const bundle = wrapKey(repo, key, data.password);
  const writable = await handle.createWritable();
  let info;
  try {
    info = await encryptPackage(
      repo,
      key,
      data.files.map(fileInput),
      {
        write: async (b) => {
          await writable.write(b as Uint8Array<ArrayBuffer>);
        },
      },
      (n) => progress("Encrypting", n, total),
    );
    await writable.close();
  } catch (e) {
    await writable.abort();
    throw e;
  }
  cipher = await handle.getFile();
  let ok = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      progress(`Uploading (attempt ${attempt + 1} of 4)`, 0, info.bytes);
      const response = await fetch(`/api/repositories/${repo}/ciphertext`, {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "x-csrf-token": data.csrf,
          "x-ciphertext-sha256": info.digest,
        },
        body: cipher,
        signal: controller.signal,
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
      });
      if (response.ok) {
        ok = true;
        break;
      }
      if (response.status < 500 && ![408, 429].includes(response.status)) break;
    } catch {
      if (controller.signal.aborted) throw new Error("Cancelled.");
    }
    if (attempt < 3)
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 1000 * 2 ** attempt);
        controller.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            reject(new Error("Cancelled."));
          },
          { once: true },
        );
      });
  }
  if (!ok) {
    await json(`/api/repositories/${repo}/fail`, data.csrf).catch(() => {});
    throw new Error(
      "Upload retries exhausted. Create a new delivery; its key will be new.",
    );
  }
  const result = await json(`/api/repositories/${repo}/finalize`, data.csrf);
  await cleanup();
  post("sent", { bundle, ...result });
}
async function receive(data: {
  repo: string;
  capability: string;
  bundle: string;
  password: string;
}) {
  repo = data.repo;
  await cleanup();
  const started = performance.now();
  key = unwrapKey(repo, data.bundle, data.password);
  post("benchmark", { unlockMs: performance.now() - started });
  const response = await fetch(`/api/recipient/${repo}`, {
    headers: { authorization: `Bearer ${data.capability}` },
    signal: controller.signal,
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "no-referrer",
  });
  if (!response.ok || !response.body)
    throw new Error("This delivery is unavailable, expired or revoked.");
  const length = Number(response.headers.get("content-length"));
  if (!Number.isSafeInteger(length) || length < 101 || length > MAX_CIPHER)
    throw new Error("Invalid ciphertext length.");
  const handle = await localFile(length, false);
  const writer = await handle.createWritable();
  let bytes = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      bytes += r.value.length;
      if (bytes > length || bytes > MAX_CIPHER)
        throw new Error("Invalid ciphertext length.");
      await writer.write(r.value);
      progress("Retrieving encrypted package", bytes, length);
    }
    if (bytes !== length) throw new Error("Encrypted package is incomplete.");
    await writer.close();
  } catch (e) {
    await reader.cancel().catch(() => {});
    await writer.abort();
    throw e;
  }
  cipher = await handle.getFile();
  verified = await verifyPackage(repo, key, fromBlob(cipher), (n) =>
    progress("Verifying entire package", n, length),
  );
  post("verified", { entries: verified.entries, bytes: verified.bytes });
}
async function output(data: { index: number; handle: FileSystemFileHandle }) {
  if (!verified || !cipher || !key)
    throw new Error("Verify the complete package before downloading.");
  if (data.index !== -1 && !verified.entries[data.index])
    throw new Error("Invalid file choice.");
  const writer = await data.handle.createWritable();
  const sink: Sink = {
    write: async (b) => {
      await writer.write(b as Uint8Array<ArrayBuffer>);
    },
  };
  const zip = data.index === -1 ? new ZipWriter(sink) : undefined;
  let bytes = 0;
  try {
    await outputPackage(
      repo,
      key,
      fromBlob(cipher),
      verified,
      async (e, i, b, first, last) => {
        if (zip) await zip.file(e, i, b, first, last);
        else if (i === data.index) await sink.write(b);
        bytes += b.length;
        progress(
          "Saving verified files",
          bytes,
          verified!.entries.reduce((n, e) => n + e.size, 0),
        );
      },
    );
    if (zip) await zip.finish();
    await writer.close();
    post("saved");
  } catch (e) {
    await writer.abort();
    throw e;
  }
}
let busy = false;
scope.onmessage = async (event) => {
  if (busy) {
    post("error", { message: "An operation is already running." });
    return;
  }
  busy = true;
  try {
    await ready;
    const { type, ...data } = event.data;
    if (type === "init") {
      await collect();
      post("ready", { password: suggestedPassword() });
    } else if (type === "send") await send(data as any);
    else if (type === "receive") await receive(data as any);
    else if (type === "output") await output(data as any);
    else if (type === "clear") {
      controller.abort();
      await cleanup();
      controller = new AbortController();
      post("cleared");
    }
  } catch (e) {
    controller.abort();
    await cleanup().catch(() => {});
    controller = new AbortController();
    post("error", {
      message: e instanceof Error ? e.message : "The operation failed safely.",
    });
  } finally {
    busy = false;
  }
};
