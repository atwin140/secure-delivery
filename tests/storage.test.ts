import { it, expect, vi } from "vitest";
import { S3Storage } from "../src/server/storage";
import { localConfig } from "./support";
const safe = (command: any) => {
  const name = command.constructor.name;
  if (name === "GetBucketPolicyStatusCommand")
    return { PolicyStatus: { IsPublic: false } };
  if (name === "GetBucketAclCommand") return { Grants: [] };
  return {};
};
it("fails closed on enabled/suspended/version history, public/unknown policy, locks, replication and API uncertainty", async () => {
  for (const [name, result] of [
    ["GetBucketVersioningCommand", { Status: "Enabled" }],
    ["GetBucketVersioningCommand", { Status: "Suspended" }],
    ["ListObjectVersionsCommand", { Versions: [{ VersionId: "retained" }] }],
    ["GetBucketPolicyStatusCommand", { PolicyStatus: { IsPublic: true } }],
    ["GetBucketPolicyStatusCommand", {}],
    [
      "GetObjectLockConfigurationCommand",
      { ObjectLockConfiguration: { ObjectLockEnabled: "Enabled" } },
    ],
    [
      "GetBucketReplicationCommand",
      { ReplicationConfiguration: { Role: "x" } },
    ],
    [
      "GetBucketReplicationCommand",
      {
        ReplicationConfiguration: { Role: "", Rules: [{ Status: "Enabled" }] },
      },
    ],
    [
      "GetBucketReplicationCommand",
      {
        ReplicationConfiguration: { Role: "", Rules: [{ Status: "Disabled" }] },
      },
    ],
  ] as const) {
    const s = new S3Storage(localConfig);
    vi.spyOn(s.client, "send").mockImplementation(async (command: any) =>
      command.constructor.name === name ? result : (safe(command) as any),
    );
    await expect(s.preflight()).rejects.toThrow();
    s.client.destroy();
  }
  const s = new S3Storage(localConfig);
  vi.spyOn(s.client, "send").mockRejectedValue(new Error("NotImplemented"));
  await expect(s.preflight()).rejects.toThrow();
  s.client.destroy();
});
it("accepts RGW's explicitly empty replication envelope while retaining other storage checks", async () => {
  for (const replication of [{ Role: "" }, { Role: "", Rules: [] }]) {
    const s = new S3Storage(localConfig);
    vi.spyOn(s.client, "send").mockImplementation(async (command: any) =>
      command.constructor.name === "GetBucketReplicationCommand"
        ? { ReplicationConfiguration: replication }
        : (safe(command) as any),
    );
    await expect(s.preflight()).resolves.toMatchObject({
      replication: "absent",
      public: false,
    });
    s.client.destroy();
  }
});
it("accepts demonstrated safe capability responses and makes multipart abort idempotent", async () => {
  const s = new S3Storage(localConfig);
  vi.spyOn(s.client, "send").mockImplementation(async (command: any) => {
    if (command.constructor.name === "AbortMultipartUploadCommand") {
      const e = new Error("not found");
      e.name = "NoSuchUpload";
      throw e;
    }
    return safe(command) as any;
  });
  await expect(s.preflight()).resolves.toMatchObject({ public: false });
  await expect(s.abort("opaque", "upload")).resolves.toBeUndefined();
  s.client.destroy();
});
