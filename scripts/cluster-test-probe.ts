// Mounted only into the isolated cluster test Job. Never prints provider objects or credentials.
import { lookup } from "node:dns/promises";
import { readConfig } from "../src/server/config";
import { productionDb } from "../src/server/db";
import { S3Storage } from "../src/server/storage";
import * as s3 from "@aws-sdk/client-s3";
import { randomBytes, createHash } from "node:crypto";
const out = (v: object) => console.log(JSON.stringify(v));
const safe = (v: unknown) =>
  typeof v === "string" && /^[A-Za-z0-9_]{1,64}$/.test(v) ? v : undefined;
const err = (e: any) => ({
  name: safe(e?.name),
  code: safe(e?.code ?? e?.cause?.code),
  http: e?.$metadata?.httpStatusCode,
});
const c = readConfig(),
  db = productionDb(c),
  storage = new S3Storage(c),
  Bucket = c.s3Bucket;
try {
  if (process.env.TEST_RESTORE_CHECK_ID) {
    const id = process.env.TEST_RESTORE_CHECK_ID;
    if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("Invalid test ID");
    const state = (
      await db.query(
        "SELECT (SELECT value FROM settings WHERE key='retrieval_enabled') AS retrieval, (SELECT count(*) FROM sessions) AS sessions, (SELECT count(*) FROM oidc_transactions) AS transactions, (SELECT count(*) FROM repositories WHERE status<>'revoked') AS not_revoked, (SELECT count(*) FROM repositories WHERE deleted_at IS NULL) AS not_deleted, (SELECT status FROM repositories WHERE id=$1) AS candidate_status",
        [id],
      )
    ).rows[0];
    const good =
      state.retrieval === false &&
      Number(state.sessions) === 0 &&
      Number(state.transactions) === 0 &&
      Number(state.not_revoked) === 0 &&
      Number(state.not_deleted) === 0 &&
      state.candidate_status === "revoked";
    let objects = 0,
      multipart = 0;
    for await (const _ of storage.objects()) objects++;
    for await (const _ of storage.multiparts()) multipart++;
    const tables = (
      await db.query(
        "SELECT (SELECT COALESCE(string_agg(row_to_json(r)::text,''),'') FROM repositories r) || (SELECT COALESCE(string_agg(row_to_json(a)::text,''),'') FROM audit a) AS data",
      )
    ).rows[0].data;
    const canariesAbsent =
      !/CLUSTER-SYNTHETIC-PLAINTEXT|CLUSTER-FILENAME-CANARY/.test(tables);
    out({
      check: "restore_invalidation",
      passed: good && objects === 0 && multipart === 0 && canariesAbsent,
      retrievalDisabled: !state.retrieval,
      sessions: Number(state.sessions),
      pendingTransactions: Number(state.transactions),
      notRevoked: Number(state.not_revoked),
      notDeleted: Number(state.not_deleted),
      candidateRevoked: state.candidate_status === "revoked",
      objectCount: objects,
      multipartCount: multipart,
      databaseCanariesAbsent: canariesAbsent,
    });
    if (!good || objects || multipart || !canariesAbsent) process.exitCode = 1;
  }
  out({
    check: "identity_dns",
    addresses: await lookup(new URL(c.issuer).hostname, { all: true }),
  });
  try {
    const r = await db.query(
      "SELECT ssl,version FROM pg_stat_ssl WHERE pid=pg_backend_pid()",
    );
    out({ check: "database_tls", result: r.rows });
  } catch (e) {
    out({ check: "database_tls", error: err(e) });
  }
  try {
    const r = await fetch(c.issuer + "/.well-known/openid-configuration", {
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });
    const body = await r.json();
    out({
      check: "identity_discovery",
      http: r.status,
      issuerMatches: body.issuer === c.issuer,
    });
  } catch (e) {
    out({ check: "identity_discovery", error: err(e) });
  }
  for (const name of [
    "GetBucketVersioningCommand",
    "GetObjectLockConfigurationCommand",
    "GetBucketReplicationCommand",
    "GetBucketLifecycleConfigurationCommand",
    "ListObjectVersionsCommand",
    "GetBucketAclCommand",
    "GetBucketPolicyStatusCommand",
    "ListMultipartUploadsCommand",
  ] as const) {
    try {
      const r: any = await storage.client.send(
        new (s3[name] as any)({ Bucket }),
        { abortSignal: AbortSignal.timeout(15000) },
      );
      out({
        check: name,
        http: r.$metadata.httpStatusCode,
        fields: Object.keys(r).filter((k) => k !== "$metadata"),
        replicationFields: r.ReplicationConfiguration
          ? Object.keys(r.ReplicationConfiguration)
          : undefined,
        replicationRules: r.ReplicationConfiguration?.Rules?.length,
        replicationRoleSet: !!r.ReplicationConfiguration?.Role,
        versionStatus: r.Status,
        versions: r.Versions?.length,
        deleteMarkers: r.DeleteMarkers?.length,
        isPublic: r.PolicyStatus?.IsPublic,
        publicAcl: r.Grants?.some((g: any) => g.Grantee?.URI),
        multipart: r.Uploads?.length,
      });
    } catch (e) {
      out({ check: name, error: err(e) });
    }
  }
  const key = randomBytes(16).toString("hex"),
    bytes = randomBytes(256),
    controller = new AbortController();
  try {
    await storage.upload(
      key,
      (async function* () {
        yield bytes;
      })(),
      bytes.length,
      createHash("sha256").update(bytes).digest("hex"),
      controller.signal,
      async () => {},
      async () => {},
    );
    const parts: Buffer[] = [];
    for await (const part of await storage.get(key, controller.signal))
      parts.push(part);
    out({
      check: "synthetic_s3_roundtrip",
      matches: Buffer.concat(parts).equals(bytes),
    });
    const r = await fetch(c.s3Endpoint + "/" + Bucket + "/" + key, {
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });
    await r.body?.cancel();
    out({
      check: "anonymous_object_access",
      http: r.status,
      denied: [403, 404].includes(r.status),
    });
  } catch (e) {
    out({ check: "synthetic_s3_roundtrip", error: err(e) });
  } finally {
    try {
      await storage.remove(key);
      out({
        check: "synthetic_s3_delete",
        absent: !(await storage.exists(key)),
      });
    } catch (e) {
      out({ check: "synthetic_s3_delete", error: err(e) });
    }
  }
} finally {
  await db.close();
  storage.client.destroy();
}
