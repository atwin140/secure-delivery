import { beforeAll, afterAll, it, expect } from "vitest";
import https from "node:https";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { S3Storage } from "../src/server/storage";
import { localConfig } from "./support";
let server: https.Server, storage: S3Storage;
const parts: Buffer[] = [];
let object: Buffer | undefined,
  aborts = 0;
beforeAll(async () => {
  server = https.createServer(
    {
      cert: await readFile(process.env.TEST_TLS_CERT!),
      key: await readFile(process.env.TEST_TLS_KEY!),
    },
    async (req, res) => {
      const url = new URL(req.url!, "https://localhost");
      res.setHeader("content-type", "application/xml");
      if (req.method === "POST" && url.searchParams.has("uploads")) {
        parts.length = 0;
        res.end(
          "<InitiateMultipartUploadResult><Bucket>development-only</Bucket><Key>opaque</Key><UploadId>synthetic-upload</UploadId></InitiateMultipartUploadResult>",
        );
      } else if (req.method === "PUT" && url.searchParams.has("partNumber")) {
        const list: Buffer[] = [];
        for await (const c of req) list.push(c);
        parts[Number(url.searchParams.get("partNumber")) - 1] =
          Buffer.concat(list);
        res.setHeader("etag", '"synthetic-part"');
        res.end();
      } else if (req.method === "POST" && url.searchParams.has("uploadId")) {
        for await (const _ of req) {
        }
        object = Buffer.concat(parts);
        res.end(
          '<CompleteMultipartUploadResult><Bucket>development-only</Bucket><Key>opaque</Key><ETag>"synthetic-complete"</ETag></CompleteMultipartUploadResult>',
        );
      } else if (req.method === "DELETE" && url.searchParams.has("uploadId")) {
        aborts++;
        res.statusCode = 204;
        res.end();
      } else if (req.method === "DELETE") {
        object = undefined;
        res.statusCode = 204;
        res.end();
      } else if (req.method === "HEAD") {
        res.statusCode = object ? 200 : 404;
        if (object) res.setHeader("content-length", object.length);
        res.end();
      } else if (req.method === "GET" && object) {
        res.setHeader("content-length", object.length);
        res.end(object);
      } else {
        res.statusCode = 404;
        res.end("<Error><Code>NoSuchKey</Code></Error>");
      }
    },
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  storage = new S3Storage({
    ...localConfig,
    s3Endpoint: `https://localhost:${(server.address() as any).port}`,
  });
});
afterAll(async () => {
  storage.client.destroy();
  await new Promise<void>((r) => server.close(() => r()));
});
it("streams multipart ciphertext over verified TLS, checks length/digest and deletes with absence evidence", async () => {
  const bytes = Buffer.alloc(9 * 1048576, 77),
    hash = createHash("sha256").update(bytes).digest("hex");
  let activity = 0,
    started = "";
  const signal = new AbortController().signal;
  await storage.upload(
    "opaque",
    (async function* () {
      for (let p = 0; p < bytes.length; p += 65536)
        yield bytes.subarray(p, p + 65536);
    })(),
    bytes.length,
    hash,
    signal,
    async (id) => {
      started = id;
    },
    async () => {
      activity++;
    },
  );
  expect(started).toBe("synthetic-upload");
  expect(parts.map((p) => p.length)).toEqual([8 * 1048576, 1048576]);
  expect(activity).toBeGreaterThan(0);
  const stream = await storage.get("opaque", signal),
    chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c);
  expect(createHash("sha256").update(Buffer.concat(chunks)).digest("hex")).toBe(
    hash,
  );
  await storage.remove("opaque");
  expect(await storage.exists("opaque")).toBe(false);
});
it("aborts incomplete, wrong-digest and cancelled uploads without completing objects", async () => {
  const b = Buffer.alloc(100);
  for (const expected of [99, 101, 100])
    await expect(
      storage.upload(
        "opaque",
        (async function* () {
          yield b;
        })(),
        expected,
        "f".repeat(64),
        new AbortController().signal,
        async () => {},
        async () => {},
      ),
    ).rejects.toThrow();
  expect(aborts).toBe(3);
  expect(object === undefined).toBe(true);
  const controller = new AbortController();
  await expect(
    storage.upload(
      "opaque",
      (async function* () {
        yield b;
      })(),
      100,
      createHash("sha256").update(b).digest("hex"),
      controller.signal,
      async () => controller.abort(),
      async () => {},
    ),
  ).rejects.toThrow();
  expect(aborts).toBe(4);
});
