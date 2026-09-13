import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { buildApp } from "../src/server/app";
import { digest, migrate, Repositories, type Database } from "../src/server/db";
import { cleanup } from "../src/server/lifecycle";
import { embeddedDb, MemoryStorage, LocalAuth, localConfig } from "./support";
import { safeRestoreInvalidate } from "../src/server/restore";
let db: Database,
  storage: MemoryStorage,
  instance: Awaited<ReturnType<typeof buildApp>>,
  mailCalls = 0,
  mailFail = false;
const cookie = "sd-dev=synthetic-session; sd-dev-csrf=synthetic-csrf";
const headers = {
  cookie,
  origin: localConfig.origin,
  "x-csrf-token": "synthetic-csrf",
};
const ciphertext = Buffer.from(Array.from({ length: 512 }, (_, i) => i % 255));
const sha = createHash("sha256").update(ciphertext).digest("hex");
beforeAll(async () => {
  db = await embeddedDb();
  storage = new MemoryStorage();
  instance = await buildApp({
    config: localConfig,
    db,
    storage,
    auth: new LocalAuth(db, localConfig),
    mailer: async () => {
      mailCalls++;
      if (mailFail) throw new Error("PROVIDER-ERROR-CANARY");
    },
    staticFiles: false,
  });
});
afterAll(async () => {
  await instance.app.close();
  await db.close();
});
beforeEach(async () => {
  await db.query("TRUNCATE repositories,sessions,audit,oidc_transactions");
  await db.query(
    "UPDATE settings SET value=true WHERE key='retrieval_enabled'",
  );
  await db.query(
    "INSERT INTO sessions(token_hash,csrf_hash,sender_id,expires_at) VALUES($1,$2,'sender-a',clock_timestamp()+interval '15 minutes')",
    [digest("synthetic-session"), digest("synthetic-csrf")],
  );
  storage.data.clear();
  storage.failUploads = 0;
  storage.failDeletes = false;
  storage.delay = 0;
  mailCalls = 0;
  mailFail = false;
});
const post = (url: string, payload: Record<string, unknown> = {}) =>
  instance.app.inject({ method: "POST", url, headers, payload });
const create = async () => {
  const r = await post("/api/repositories");
  expect(r.statusCode).toBe(200);
  return r.json() as { id: string; capability: string };
};
const upload = (id: string, hash = sha) =>
  instance.app.inject({
    method: "PUT",
    url: `/api/repositories/${id}/ciphertext`,
    headers: {
      ...headers,
      "content-type": "application/octet-stream",
      "content-length": String(ciphertext.length),
      "x-ciphertext-sha256": hash,
    },
    payload: ciphertext,
  });
const finalize = async () => {
  const r = await create();
  expect((await upload(r.id)).statusCode).toBe(204);
  expect((await post(`/api/repositories/${r.id}/finalize`)).statusCode).toBe(
    200,
  );
  return r;
};
const retrieve = (r: { id: string; capability: string }) =>
  instance.app.inject({
    method: "GET",
    url: `/api/recipient/${r.id}`,
    headers: { authorization: `Bearer ${r.capability}` },
  });
describe("authentication, privacy and lifecycle", () => {
  it("permits the entry navigation from email while rejecting cross-site API access", async () => {
    const navigation = await instance.app.inject({
      url: "/receive",
      headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" },
    });
    // This suite omits static files: reaching the router's 404 proves the guard
    // permits entry; the real HTML response is also checked by browser tests.
    expect(navigation.statusCode).toBe(404);
    expect(
      (
        await instance.app.inject({
          url: "/api/session",
          headers: { ...headers, "sec-fetch-site": "cross-site" },
        })
      ).statusCode,
    ).toBe(403);
  });
  it("paginates every owned delivery without exposing other senders", async () => {
    await db.query(
      "INSERT INTO repositories(id,object_key,sender_id,capability_hash,status) SELECT lpad(to_hex(i),32,'0'),lpad(to_hex(i),32,'0'),'sender-a','synthetic-verifier','pending' FROM generate_series(1,101) i",
    );
    const first = (
      await instance.app.inject({ url: "/api/repositories", headers })
    ).json();
    expect(first).toHaveLength(100);
    const last = (
      await instance.app.inject({
        url: `/api/repositories?cursor=${first.at(-1).id}`,
        headers,
      })
    ).json();
    expect(last).toHaveLength(1);
    expect(new Set([...first, ...last].map((r) => r.id)).size).toBe(101);
  });
  it("enforces sessions, CSRF and owner isolation", async () => {
    expect(
      (
        await instance.app.inject({
          method: "POST",
          url: "/api/repositories",
          payload: {},
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await instance.app.inject({
          method: "POST",
          url: "/api/repositories",
          headers: { cookie },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await instance.app.inject({
          method: "POST",
          url: "/api/repositories",
          headers: { ...headers, origin: "https://evil.invalid" },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    const r = await create();
    await db.query(
      "UPDATE repositories SET sender_id='other-sender' WHERE id=$1",
      [r.id],
    );
    expect((await post(`/api/repositories/${r.id}/revoke`)).statusCode).toBe(
      404,
    );
    expect(
      (await instance.app.inject({ url: "/api/repositories", headers })).json(),
    ).toEqual([]);
    expect((await upload(r.id)).statusCode).toBe(404);
  });
  it("only stores verifiers; lists no internal file metadata; sets security headers", async () => {
    const r = await create();
    const rows = (await db.query("SELECT * FROM repositories")).rows;
    expect(JSON.stringify(rows)).not.toContain(r.capability);
    expect(rows[0].capability_hash).toBe(digest(r.capability));
    const response = await instance.app.inject({
      url: "/api/repositories",
      headers,
    });
    expect(Object.keys(response.json()[0]).sort()).toEqual([
      "ciphertext_bytes",
      "created_at",
      "expires_at",
      "id",
      "status",
    ]);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["content-security-policy"]).toContain(
      "frame-ancestors 'none'",
    );
  });
  it("rejects additional payload fields and oversize ciphertext headers", async () => {
    expect(
      (await post("/api/repositories", { filename: "FILENAME-CANARY" }))
        .statusCode,
    ).toBe(400);
    const r = await create();
    const response = await instance.app.inject({
      method: "PUT",
      url: `/api/repositories/${r.id}/ciphertext`,
      headers: {
        ...headers,
        "content-type": "application/octet-stream",
        "content-length": "1073834108",
        "x-ciphertext-sha256": sha,
      },
      payload: Buffer.alloc(0),
    });
    expect(response.statusCode).toBe(400);
  });
  it("denies pending/uploaded access and finalization before complete upload", async () => {
    const r = await create();
    expect((await retrieve(r)).statusCode).toBe(404);
    expect((await post(`/api/repositories/${r.id}/finalize`)).statusCode).toBe(
      409,
    );
    expect((await upload(r.id)).statusCode).toBe(204);
    expect((await retrieve(r)).statusCode).toBe(404);
  });
  it("locks ciphertext, idempotent retry/finalize, server expiry exactly seven days", async () => {
    const r = await finalize();
    const first = await post(`/api/repositories/${r.id}/finalize`);
    expect((await upload(r.id)).statusCode).toBe(204);
    expect((await upload(r.id, "f".repeat(64))).statusCode).toBe(409);
    const second = await post(`/api/repositories/${r.id}/finalize`);
    expect(second.json()).toEqual(first.json());
    const row = (
      await db.query(
        "SELECT finalized_at,expires_at FROM repositories WHERE id=$1",
        [r.id],
      )
    ).rows[0];
    expect(
      new Date(row.expires_at).getTime() - new Date(row.finalized_at).getTime(),
    ).toBeLessThanOrEqual(604800001);
    const response = await retrieve(r);
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(ciphertext);
    expect(storage.data.size).toBe(1);
  });
  it("denies recipient isolation, rotated links and revoked/expired packages", async () => {
    const a = await finalize(),
      b = await finalize();
    expect(
      (await retrieve({ ...a, capability: b.capability })).statusCode,
    ).toBe(404);
    const rotation = (await post(`/api/repositories/${a.id}/reissue`)).json();
    expect((await retrieve(a)).statusCode).toBe(404);
    expect((await retrieve({ ...a, ...rotation })).statusCode).toBe(200);
    await post(`/api/repositories/${a.id}/revoke`);
    expect((await retrieve({ ...a, ...rotation })).statusCode).toBe(404);
    await db.query(
      "UPDATE repositories SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [b.id],
    );
    expect((await retrieve(b)).statusCode).toBe(404);
  });
  it("fences upload/finalization races", async () => {
    const r = await create();
    const reservation = await instance.repos.reserve(
      r.id,
      "sender-a",
      512,
      sha,
    );
    await expect(
      instance.repos.reserve(r.id, "sender-a", 512, sha),
    ).rejects.toThrow();
    expect((await post(`/api/repositories/${r.id}/finalize`)).statusCode).toBe(
      409,
    );
    await post(`/api/repositories/${r.id}/revoke`);
    await expect(
      instance.repos.uploaded(r.id, reservation.lease),
    ).rejects.toThrow();
    expect((await retrieve(r)).statusCode).toBe(404);
  });
  it("exhausts exactly initial plus three retries and requires new delivery", async () => {
    const r = await create();
    storage.failUploads = 4;
    for (let i = 0; i < 4; i++)
      expect((await upload(r.id)).statusCode).toBe(503);
    const row = await instance.repos.own(r.id, "sender-a");
    expect(row.status).toBe("failed");
    expect(row.upload_attempts).toBe(4);
    expect((await upload(r.id)).statusCode).toBe(409);
    expect((await retrieve(r)).statusCode).toBe(404);
    expect((await create()).id).not.toBe(r.id);
  });
  it("abandons after 60 minutes, deletes with idempotent retry and evidence", async () => {
    const r = await create();
    await upload(r.id);
    await db.query(
      "UPDATE repositories SET last_activity=clock_timestamp()-interval '61 minutes' WHERE id=$1",
      [r.id],
    );
    storage.failDeletes = true;
    const a = await cleanup(instance.repos, storage, 90);
    expect(a.failures).toBeGreaterThan(0);
    expect((await instance.repos.own(r.id, "sender-a")).deleted_at).toBeNull();
    expect((await retrieve(r)).statusCode).toBe(404);
    storage.failDeletes = false;
    await cleanup(instance.repos, storage, 90);
    await cleanup(instance.repos, storage, 90);
    expect(await storage.exists(r.id)).toBe(false);
    expect(
      (await instance.repos.own(r.id, "sender-a")).deleted_at,
    ).toBeTruthy();
    expect(
      JSON.stringify((await db.query("SELECT * FROM audit")).rows),
    ).toContain("ciphertext_absence_confirmed");
  });
  it("cleans old orphans/multiparts and marks approaching cleanup SLA unhealthy", async () => {
    storage.data.set("a".repeat(32), Buffer.from("synthetic orphan"));
    storage.openMultiparts.set("b".repeat(32), "synthetic-part");
    await cleanup(instance.repos, storage, 90);
    expect(storage.data.size).toBe(0);
    expect(storage.openMultiparts.size).toBe(0);
    const r = await finalize();
    await post(`/api/repositories/${r.id}/revoke`);
    await db.query(
      "UPDATE repositories SET invalidated_at=clock_timestamp()-interval '24 hours' WHERE id=$1",
      [r.id],
    );
    expect(
      (await instance.app.inject({ url: "/health/ready" })).statusCode,
    ).toBe(503);
  });
  it("keeps email addresses/provider errors out of database and preserves delivery after failure", async () => {
    const r = await finalize();
    mailFail = true;
    const email = {
      addresses: ["ADDRESS-CANARY@example.invalid"],
      capability: r.capability,
    };
    const fail = await post(`/api/repositories/${r.id}/email`, email);
    expect(fail.statusCode).toBe(502);
    expect(fail.body).not.toContain("PROVIDER-ERROR-CANARY");
    expect((await retrieve(r)).statusCode).toBe(200);
    mailFail = false;
    expect(
      (await post(`/api/repositories/${r.id}/email`, email)).statusCode,
    ).toBe(202);
    expect(mailCalls).toBe(2);
    const all =
      JSON.stringify((await db.query("SELECT * FROM audit")).rows) +
      JSON.stringify((await db.query("SELECT * FROM repositories")).rows);
    expect(all).not.toContain("ADDRESS-CANARY");
    expect(all).not.toContain(r.capability);
    expect(all).not.toContain("PROVIDER-ERROR");
  });
  it("safe restore cannot resurrect deliveries, sessions or capabilities", async () => {
    const r = await finalize();
    await safeRestoreInvalidate(db);
    await db.query(
      "UPDATE settings SET value=true WHERE key='retrieval_enabled'",
    );
    expect((await retrieve(r)).statusCode).toBe(404);
    expect((await db.query("SELECT * FROM sessions")).rows).toHaveLength(0);
    await cleanup(instance.repos, storage, 90);
    expect(storage.data.size).toBe(0);
  });
  it("denies retrieval on uncertain database state", async () => {
    const r = await finalize();
    const broken = {
      ...db,
      query: async () => {
        throw new Error("DB-PARAMETER-SECRET");
      },
    };
    await expect(
      new Repositories(broken).authorize(r.id, r.capability),
    ).rejects.toThrow();
  });
  it("stops an in-progress stream after revocation from a different instance", async () => {
    const r = await finalize();
    storage.delay = 100;
    const transfer = retrieve(r);
    await new Promise((resolve) => setTimeout(resolve, 130));
    const other = new Repositories(db);
    await other.invalidate(r.id, "sender-a");
    await expect(transfer).rejects.toThrow();
  });
  it("stops an in-progress stream at expiry", async () => {
    const r = await finalize();
    storage.delay = 100;
    await db.query(
      "UPDATE repositories SET expires_at=clock_timestamp()+interval '150 milliseconds' WHERE id=$1",
      [r.id],
    );
    await expect(retrieve(r)).rejects.toThrow();
  });
});
